import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { createGitHubClient, githubToken, repositoryFromRemote } from './github-client.mjs';
import {
  Stage2WorkerError,
  claimNextStage2Batch,
  createGitRepository,
  eligibleBatches,
  loadFactorySnapshot,
  releaseClaimAfterMerge,
  runStage2Session,
  waitForPullRequestMerge,
} from './stage2-worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArguments(argv) {
  const options = { agent: 'codex', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--agent' || argument.startsWith('--agent=')) {
      const value = argument === '--agent' ? argv[++index] : argument.slice('--agent='.length);
      if (!value || value.startsWith('--')) throw new Error('--agent requires codex or claude');
      options.agent = value;
    } else if (argument === '--repo' || argument.startsWith('--repo=')) {
      const value = argument === '--repo' ? argv[++index] : argument.slice('--repo='.length);
      if (!value || value.startsWith('--')) throw new Error('--repo requires owner/name');
      options.repositoryFullName = value;
    } else throw new Error('unknown argument ' + argument);
  }
  if (!['codex', 'claude'].includes(options.agent)) throw new Error('--agent must be codex or claude');
  if (options.repositoryFullName && !/^[^/]+\/[^/]+$/u.test(options.repositoryFullName)) {
    throw new Error('--repo must be owner/name');
  }
  return options;
}

export const HELP = [
  'Run the serial Stage 2 worker until master has no unclaimed batches.',
  '',
  'Usage: pnpm run factory:stage2 --agent codex|claude [--repo owner/name] [--dry-run]',
  '',
  'The command claims a batch, then pauses for the active primary agent to complete full QA and create its result PR.',
  'It monitors that PR, releases the claim only after the result is present on master, and then claims the next batch.',
  'Respond to each JSON hand-off on stdin with the requested JSON reply; no other agent or model is started.',
].join('\n');

export function createInteractiveStage2Callbacks({
  github, input = process.stdin, output = process.stdout, sleep,
} = {}) {
  const prompts = createInterface({ input, output, terminal: false });
  const ask = async (message) => {
    output.write(JSON.stringify(message) + '\n');
    const context = {
      batchId: message.claim?.batchId,
      claimCreated: Boolean(message.claim),
      issueNumber: message.claim?.issueNumber,
    };
    let line;
    try {
      line = await prompts.question('');
    } catch {
      throw new Stage2WorkerError('stdin closed during the Stage 2 session; preserving the current claim', context);
    }
    let reply;
    try { reply = JSON.parse(line); } catch {
      throw new Stage2WorkerError('primary context must reply with one JSON object per hand-off', context);
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
      throw new Stage2WorkerError('primary context reply must be a JSON object', context);
    }
    return reply;
  };
  return {
    async startResultPr(claim) {
      const reply = await ask({
        event: 'AUTHOR_STAGE2_RESULT',
        claim,
        instructions: [
          'Complete full lexical authoring and source-bound semantic QA on the current branch.',
          'Before finalizing a usage-group deferral whose only remaining reason is insufficient contextual evidence (no hard hold), run one bounded lookup: pnpm run factory:literature-rescue lookup <batch> <candidate> <group>. Judge the actual contexts yourself; record the text-free result as literature_lookup on that group_decisions entry (informed / deferral_changed_to_included are yours to set). No hit or an unavailable lookup is not negative evidence.',
          'After glosses and sense boundaries are fixed, run relation enrichment for every admitted sense: pnpm run relation:candidates <batch> --out <file>. Review roughly 20 candidates per sense where available (more when useful), judge each yourself, and author genuine direct (유의어), antonym (반의어), near/mood (말의 결; near is only for closely meaning-adjacent alternatives, so hypernym/hyponym "X is a kind of Y" links, part-whole and domain membership are association or omitted, never near; judge near from the actual bound target sense gloss and part of speech, never from shared gloss words, so a wider or narrower extent, a literal versus figurative sense, a state versus an action or attitude, or a cause versus an act is association; a same-root or same-event rationale alone does not make near: when a noun names an event, state or quality and a related verb or adjective is linked only because of that derivation, use association if the writer-useful connection merits it, otherwise omit it; keep near only when the bound senses themselves remain meaning-adjacent beyond their derivational relationship; a different root does not rescue a pair whose bound senses differ as a state noun versus a predicate (adjective or verb), as an attempt versus an achieved result, or as a whole versus a narrower part of its time span or scene, so those are association or omitted (미온 to 미지근하다, 찾다 to 찾아내다 and 저녁 to 저녁때 are association, while 미온 to 미지근함 and 향내 to 향기 stay near); near needs the two bound glosses to cover the same extent, so a target that is a room versus a wider space, a light source or purpose versus any light, a literal versus a figurative use, or reciting what is remembered versus committing it to memory is association, and so is a feeling versus the inner act or outward attitude that comes from it and an act versus the state it leaves (다락방 to 다락, 불빛 to 조명, 번쩍이다 to 번뜩이다, 외다 to 외우다, 죄책감 to 자책, 비벼대다 to 비비다); a target that is wider than the source is association even when another target of the same source was already lowered for that reason; when the already-authored reverse link is the one in error, a relation-only backfill cannot retype it, so omit the new forward link instead of authoring a contradiction and record the reverse for a separate source-preserving correction (죄책감 to 자책), and the same applies when a reverse near already exists and the target names a domain the source does not, such as a reaction added to a temperature (미지근함 to 미온): do not repeat that near in the new direction, and the listing also raises every new association whose opposite link is an authored near: when both notes name the same difference of part of speech, mind versus act, phenomenon versus tool or extent (자부심 to 뿌듯하다, 불빛 to 등불), omit the new association, list the existing reverse for the separate correction, and keep a different type only for a role that really differs by direction (기쁨 to 웃다 action, 웃다 to 기쁨 mood), while 공책 to 노트 and 울림 to 음향 stay near; a pair whose bound glosses cover the same extent and whose recorded substitution frame (one sentence with the source word and the target word swapped) holds in this direction is direct without relevance whether or not any reverse link exists, never near (총성 to 총소리, 붉은색 to 레드), while 훈기 to 온기 stays near because 온기 also names heat; a pair that shares a domain but differs in vehicle, place, body part or scene is association even when the glosses look alike, and so is a source whose target is a wider parent or a narrower kind or part of it (정거장 to 정류장 differ by rail versus bus, 늪 to 습지 and 봉투 to 편지봉투 are kind and parent), while near words inside one domain that share the same meaning stay near (정거장 to 기차역, 향내 to 향기); read each retained near against the own gloss and part of speech of the target sense, not against the source gloss alone; before finalizing, run pnpm run relation:near-review <packet.json> (a read-only listing of each near tuple with its bound source and target gloss and part of speech, the opposite link and every other link of the same source) and read its notes as well as its types and its only-in-source and only-in-target gloss words (a qualifier that one gloss adds or drops is a different extent, 단정하다 to 말끔하다) and compare them with the note you wrote instead of judging from memory, restating the target in the words of its own gloss and checking the listing for note words taken from the source gloss only or found in neither gloss (a note that says 없어진다 for a target glossed 약해지다 gives the target a meaning it lacks, 사그라지다 to 사그라들다), and when the extent is in doubt choose association, the honest broader type, rather than near, then run a bounded same-source-sense consistency pass: compare every retained near against the other near and association links authored from that same source sense, especially differences of broad versus narrow extent, formal or public qualifiers, literal versus figurative use, and action versus state, e.g. if 소아 to 아동 is association because 아동 also covers adolescents, then 소아 to 아이 needs the same reasoning, while 소아 to 어린이 can stay near, and if 선서 to 맹세 is association because 맹세 lacks the public element, 선서 to 서약 must be judged the same way; when classifications differ, state the specific difference or correct them; when a reverse link between the same two senses is already authored, check that the two rationales do not contradict each other about whether the words are substitutable (one direction near and the other association for the same reason is a contradiction); when that reverse link is an authored direct, a new near or association in the other direction needs a sense-bound difference of extent, part of speech or aspect stated in its note, while a pair whose bound glosses match in extent and whose recorded substitution frame also holds in this direction is authored direct without relevance, not near (감촉 to 촉감 after 촉감 to 감촉 direct), and the same holds when no reverse link exists at all: write the substitution sentence once for every near before keeping it, and when the bound glosses cover the same extent and the sentence holds in both words the pair is direct without relevance (멈추다 to 그치다, 플랫폼 to 승강장), while a near keeps its type only when a concrete difference breaks the substitution and its note names that difference (공책 to 노트, 다락방 to 다락), where the difference must be a qualifier that one of the two bound glosses itself contains and the other lacks: another sense of the lemma, whole-lemma usage, idioms or grammar claims that neither gloss states are not a difference, and a pair whose glosses show none is direct, or omitted when its reverse is an authored near, but a direct also needs a real sentence in which each word keeps the arguments, case markers or fixed collocation that its own bound sense requires (쓸어내리다 needs 가슴을 for the relief sense, 만나다 takes 을/를 where 마주치다 takes 와), and a pair whose sentence breaks on that stays near with the break named, and a near must carry both a sentence that works and a contrast sentence in which the substitution breaks, the break being a qualifier of one bound gloss, and a pair for which no such contrast can be written is direct, or is omitted and left for the separate correction when its reverse is an authored near (바라다보다 to 바라보다), and one sentence that works is not proof of the same extent, so a direct also needs bound glosses with no qualifier on one side only (처소 to 거주지 stays near because 머물러 지내는 곳 is wider than 머물러 사는 곳), and the sentence must use the two bound senses in their own part of speech, so a noun pair is shown with the two nouns themselves and not with the -하다 verbs or adjectives derived from them, and a broader source to a narrower target stays near or association (달콤함 to 단맛, 아픔 to 통증); legitimately direction-specific types such as 기쁨 to 웃다 action versus 웃다 to 기쁨 mood stay as authored, and never create or retype a reverse link only for symmetry) and scene/sensory/action/association (연상) relations in reviewed_record.senses[].relations with relevance where required; reverse links to existing senses go in relation_amendments. Record relation_decision relations-reviewed or no-relations (with a sense-bound rationale) per sense. Zero relations is a valid outcome and never blocks admission; there is no relation quota.',
          'Run the shared validators and prospective canonical preflight without editing canonical JSONL.',
          'Commit and push the result branch, then create exactly one result PR that closes the tracking Issue.',
          'Reply with {"action":"created","pr_number":123} after the PR exists, or {"action":"stop"} to stop safely.',
        ],
      });
      if (reply.action === 'stop') {
        throw new Stage2WorkerError('primary context stopped after claiming ' + claim.batchId, {
          batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
        });
      }
      if (reply.action !== 'created' || !Number.isInteger(reply.pr_number) || reply.pr_number < 1) {
        throw new Stage2WorkerError('expected action created with a numeric pr_number', {
          batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
        });
      }
      return { number: reply.pr_number, url: reply.url };
    },
    async waitForMerge(claim, pullRequest) {
      return waitForPullRequestMerge({
        github, prNumber: pullRequest.number, sleep,
        onPending: async (snapshot) => {
          const reply = await ask({
            event: 'STAGE2_PR_PENDING',
            claim,
            pullRequest: snapshot.pullRequest || snapshot,
            reviews: snapshot.reviews || [],
            inlineComments: snapshot.inlineComments || [],
            conversationComments: snapshot.conversationComments || [],
            combinedStatus: snapshot.combinedStatus || null,
            checkRuns: snapshot.checkRuns || [],
            instructions: 'Check the current head, review batch, comments, and CI. Apply accepted fixes to this same branch, push them, then reply {"action":"continue"} to wait another five minutes, or {"action":"stop"} to end without claiming another batch.',
          });
          if (reply.action === 'stop') {
            return { status: 'stopped-by-primary' };
          }
          if (reply.action !== 'continue') throw new Stage2WorkerError('expected action continue or stop while the result PR is open', {
            batchId: claim.batchId, claimCreated: true, issueNumber: claim.issueNumber,
          });
        },
      });
    },
    close() {
      prompts.close();
    },
  };
}

export async function runStage2Cli(argv, {
  root = ROOT, env = process.env, log = console.log,
  makeGit = createGitRepository, makeGithub = createGitHubClient,
  loadSnapshot = loadFactorySnapshot, sessionCallbacks,
} = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    log(HELP);
    return { status: 'help' };
  }
  const git = makeGit({ root });
  const repositoryFullName = options.repositoryFullName || repositoryFromRemote(git.originRemote());
  const github = makeGithub({ repositoryFullName, token: githubToken({ env }) });

  if (options.dryRun) {
    await git.fetchMaster();
    const headSha = await github.getBranchHead('master');
    if (git.resolveRef('origin/master') !== headSha) throw new Error('local origin/master does not match GitHub master');
    const snapshot = await loadSnapshot({ git, headSha });
    const candidate = eligibleBatches(snapshot, await github.listClaimRefs())[0];
    const result = candidate
      ? { status: 'dry-run', batchId: candidate.batchId, attempt: candidate.attempt, rework: candidate.rework, baseSha: headSha }
      : { status: 'no-unclaimed-batches', baseSha: headSha };
    log(JSON.stringify(result));
    return result;
  }

  const callbacks = sessionCallbacks || createInteractiveStage2Callbacks({ github, input: process.stdin, output: process.stdout });
  try {
    const completed = await runStage2Session({
      claimNext: () => claimNextStage2Batch({ github, git, agent: options.agent, loadSnapshot, log }),
      startResultPr: callbacks.startResultPr,
      waitForMerge: callbacks.waitForMerge,
      releaseClaim: (claim, pullRequest) => releaseClaimAfterMerge({
        github, git, claim, prNumber: pullRequest.number, loadSnapshot,
      }),
      report: log,
    });
    const result = { status: 'session-finished', mergedBatchCount: completed.length, completed };
    log(JSON.stringify(result));
    return result;
  } finally {
    callbacks.close?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStage2Cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error.claimCreated) console.error('Claim ref remains in place; do not delete or adopt it automatically.');
    process.exitCode = 1;
  });
}
