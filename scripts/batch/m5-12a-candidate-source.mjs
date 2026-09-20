// Typewriter-authored M5-12A candidate identities.
//
// Candidate bodies are generated into an external temporary workspace by the
// M5-12A pipeline. This module is the durable identity source: every slot has
// an inventory identity, a real writer-facing lemma, a proposed canonical ID,
// and explicit lexical classification metadata.

const AXIS_GROUPS = Object.freeze([
  {
    axis: 'E',
    count: 120,
    flags: ['mood-range'],
    recordType: 'entry',
    pos: 'noun',
    roots: '설렘|기대|환희|기쁨|벅참|감격|감사|안도|안심|평온|고요|외로움|쓸쓸함|허전함|막막함|불안|초조|긴장|두려움|공포|걱정|후회|미련|아쉬움|체념|허무|허탈|분노|원망|질투|시기|부끄러움|민망함|당혹감|난감함|당황|애틋함|그리움|애도|연민|공감|자부심|자신감|의심|호기심|놀라움|경외|경탄|감탄|무력감',
    suffixes: '의 결|의 잔향|의 물결',
  },
  {
    axis: 'Q',
    count: 120,
    flags: ['direct-boundary'],
    recordType: 'entry',
    pos: 'noun',
    roots: '선명함|흐릿함|또렷함|희미함|단단함|무름|가벼움|무거움|깊이|얕음|넓이|좁음|높이|낮음|빠르기|느림|차가움|따뜻함|뜨거움|서늘함|거침|매끄러움|부드러움|거칠음|밝음|어두움|짙음|옅음|농도|밀도|빈틈|여백|간격|균형|기울기|방향|속도|강도|세기|리듬|박자|호흡|무게감|온도|질감|농담|대비|선명도',
    suffixes: '의 결|의 기세|의 온도',
  },
  {
    axis: 'S',
    count: 120,
    flags: ['sensory-transfer'],
    recordType: 'entry',
    pos: 'noun',
    roots: '소리|울림|메아리|속삭임|숨소리|발소리|빗소리|파도소리|바람소리|종소리|목소리|빛|불빛|햇빛|달빛|별빛|그림자|어둠|냄새|향기|비누향|흙내음|풀내음|비린내|향내|맛|단맛|쓴맛|신맛|짠맛|매운맛|온기|냉기|열기|촉감|감촉|결|거칠기|떨림|맥박|숨결|눈물|땀|입김|살결|손끝|발바닥',
    suffixes: '의 결|의 잔향|의 기척',
  },
  {
    axis: 'C',
    count: 120,
    flags: ['scene-expansion'],
    recordType: 'entry',
    pos: 'noun',
    roots: '새벽|아침|낮|저녁|밤|한밤중|계절|봄|여름|가을|겨울|비|눈|서리|안개|구름|바람|햇살|노을|달|별|강|바다|호수|숲|들판|골목|거리|광장|마당|창가|부엌|방|복도|계단|지붕|담장|길모퉁이|역|정류장|시장|학교|병원|극장|공원|정원|폐허|빈집|건널목',
    suffixes: '의 가장자리|의 기척|의 풍경|에 남은 시간',
  },
  {
    axis: 'A',
    count: 140,
    flags: ['action-direction'],
    recordType: 'entry',
    pos: 'noun',
    roots: '걷기|달리기|멈춤|기다림|머뭇거림|돌아섬|다가섬|물러섬|마주침|스침|바라봄|올려다봄|내려다봄|들여다봄|돌아봄|건넴|붙잡음|놓음|밀어냄|끌어당김|열기|닫기|두드림|만짐|쥠|펼침|접음|넘김|적기|지움|읽기|듣기|말하기|침묵|숨김|드러냄|나눔|건너감|들어섬|빠져나옴|기울임|기대기|일어섬|앉음|몸짓|손짓|고개짓|눈짓|한숨|웃음|울음',
    suffixes: '의 방향|의 리듬|의 순간',
  },
  {
    axis: 'O',
    count: 100,
    flags: ['direct-boundary'],
    recordType: 'entry',
    pos: 'noun',
    roots: '문|창문|커튼|의자|책상|서랍|서가|책|노트|연필|편지|봉투|사진|액자|거울|시계|달력|전등|양초|성냥|컵|찻잔|그릇|주전자|냄비|숟가락|젓가락|칼|가위|바늘|실|천|단추|장갑|목도리|신발|우산|가방|배낭|상자|바구니|자물쇠|열쇠|벤치|사다리|망치|톱|삽|빗자루|갈퀴',
    suffixes: '의 표면|의 모서리|의 무게',
  },
  {
    axis: 'X',
    count: 82,
    flags: ['direct-boundary'],
    recordType: 'expression',
    pos: 'expression',
    roots: '마음을 비우다|마음을 세우다|마음을 숨기다|마음을 돌리다|마음을 풀다|마음을 흔들다|마음이 흔들리다|마음이 기울다|가슴을 움켜쥐다|숨을 가다듬다|숨이 차오르다|숨이 멎다|목소리를 높이다|눈을 돌리다|눈길을 보내다|시선을 두다|시선을 피하다|손을 흔들다|손을 벌리다|손을 포개다|손끝을 떨다|발끝을 세우다|발을 멈추다|발걸음을 재촉하다|발길을 멈추다|고개를 기울이다|고개를 끄덕이다|어깨를 낮추다|등을 굽히다|입술을 다물다|말문을 열다|말을 흐리다|표정을 굳히다|표정을 풀다|얼굴을 붉히다|낯을 익히다|기억을 붙잡다|생각을 걷어내다|생각을 가다듬다|마음을 가누다|마음에 새기다|마음에서 지우다|길을 나서다|길을 찾다|길을 비키다|자리를 지키다|자리를 뜨다|자리를 내주다|문을 두드리다|문을 열어젖히다|문을 걸어 잠그다|창을 열다|창을 닫다|불을 밝히다|불을 끄다|빛을 좇다|그림자를 밟다|비를 맞다|바람을 맞다|흔적을 지우다|시간을 견디다|시간을 건너다|한숨을 내쉬다|눈물을 삼키다|눈물을 닦다|발걸음을 늦추다|발끝을 돌리다|고개를 가로젓다|눈을 내리깔다|손을 움켜쥐다|손가락을 세다|목을 가다듬다|목소리를 삼키다|말을 다듬다|표정을 감추다|얼굴을 들다|어깨를 움츠리다|등을 세우다|발을 구르다|길을 돌아서다|자리를 비우다|문턱을 넘다|창가에 서다',
    suffixes: '',
  },
]);

export const M5_12A_BATCH_ID = 'm5-12a-expansion-20260920';
export const M5_12A_ISSUE = 138;
export const M5_12A_PARENT_ISSUE = 98;
export const M5_12A_GRANDPARENT_ISSUE = 7;
export const M5_12A_SELECTION_COUNT = 802;
export const M5_12A_IMPORT_COUNT = 722;
export const M5_12A_RESERVE_COUNT = 80;
export const M5_12A_FIRST_INVENTORY_NUMBER = 1085;
export const M5_12A_FIRST_CANONICAL_NUMBER = 1279;
export const M5_12A_GENERATION_PASS_ID = 'm5-12a-generation-20260920';
export const M5_12A_VERIFICATION_PASS_ID = 'm5-12a-agent-semantic-review-20260920-r3';
export const M5_12A_CANDIDATE_SOURCE_ID = 'm5-12a-typewriter-authored-identities-20260920';

function splitValues(value) {
  return value ? value.split('|') : [];
}

function makeAxisIdentities(group, startIndex) {
  const roots = splitValues(group.roots);
  const suffixes = group.suffixes ? splitValues(group.suffixes) : [''];
  const values = [];
  for (const root of roots) {
    for (const suffix of suffixes) {
      if (values.length >= group.count) break;
      values.push({
        lemma: suffix ? `${root}${suffix}` : root,
        axis: group.axis,
        flags: [...group.flags],
        record_type: group.recordType,
        pos: group.pos,
        source_kind: suffix ? 'typewriter-authored-composition' : 'typewriter-authored-expression',
      });
    }
    if (values.length >= group.count) break;
  }
  if (values.length !== group.count) {
    throw new Error(`M5-12A axis ${group.axis} produced ${values.length}, expected ${group.count}`);
  }
  return values.map((value, offset) => ({
    ...value,
    catalog_index: startIndex + offset,
  }));
}

let catalogIndex = 0;
const generatedIdentities = [];
for (const group of AXIS_GROUPS) {
  const rows = makeAxisIdentities(group, catalogIndex);
  generatedIdentities.push(...rows);
  catalogIndex += rows.length;
}

export const M5_12A_CANDIDATE_IDENTITIES = Object.freeze(
  generatedIdentities.map((identity, index) => Object.freeze({
    ...identity,
    slot_id: `m5-12-slot-${String(index + 1).padStart(4, '0')}`,
    inventory_id: `m5-${String(M5_12A_FIRST_INVENTORY_NUMBER + index).padStart(4, '0')}`,
    candidate_record_id: `w${String(M5_12A_FIRST_CANONICAL_NUMBER + index).padStart(4, '0')}`,
  })),
);

if (M5_12A_CANDIDATE_IDENTITIES.length !== M5_12A_SELECTION_COUNT) {
  throw new Error(
    `M5-12A candidate identity source must contain ${M5_12A_SELECTION_COUNT} rows; got ${M5_12A_CANDIDATE_IDENTITIES.length}`,
  );
}

const seenInventoryIds = new Set();
const seenSlots = new Set();
const seenCandidateIds = new Set();
const seenLemmas = new Set();
for (const identity of M5_12A_CANDIDATE_IDENTITIES) {
  for (const [set, key] of [
    [seenInventoryIds, 'inventory_id'],
    [seenSlots, 'slot_id'],
    [seenCandidateIds, 'candidate_record_id'],
    [seenLemmas, 'lemma'],
  ]) {
    if (set.has(identity[key])) throw new Error(`duplicate M5-12A ${key}: ${identity[key]}`);
    set.add(identity[key]);
  }
  if (identity.lemma.normalize('NFC') !== identity.lemma) {
    throw new Error(`M5-12A candidate lemma is not NFC-normalized: ${identity.lemma}`);
  }
}
