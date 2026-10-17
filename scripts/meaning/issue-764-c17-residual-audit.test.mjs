import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectMeaningRelations } from './project.mjs';

// Manual audit-coverage regression. Run directly with:
// node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs
// This checks evidence coverage and selected source-bound boundary regressions; it does not infer lexical identity.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const meaningDir = path.join(root, 'data/meanings');
const canonicalDir = path.join(root, 'data/canonical');
const reviewCases = [
  { lemma: '태즈메이니아', before: [['w343346-s1'], ['w343346-s2']], groups: [['w343346-s1', 'w343346-s2']] },
  { lemma: '탐라', before: [['w345436-s1'], ['w345436-s2']], groups: [['w345436-s1', 'w345436-s2']] },
  { lemma: '터놓다', before: [['w496506-s1'], ['w496506-s2'], ['w496506-s3']], groups: [['w496506-s1', 'w496506-s2', 'w496506-s3']] },
  { lemma: '타살', before: [['w335985-s1', 'w336289-s1'], ['w336289-s2']], groups: [['w335985-s1'], ['w336289-s1', 'w336289-s2']] },
  { lemma: '타상', before: [['w340436-s1'], ['w340437-s1'], ['w497650-s1']], groups: [['w340436-s1'], ['w340437-s1'], ['w497650-s1']] },
  { lemma: '타점', before: [['w345148-s1'], ['w345148-s2'], ['w345149-s1'], ['w497740-s1'], ['w497740-s2']], groups: [['w345148-s1'], ['w345148-s2'], ['w345149-s1'], ['w497740-s1'], ['w497740-s2']] },
  { lemma: '탁발하다', before: [['w342605-s1'], ['w345543-s1'], ['w345545-s1']], groups: [['w342605-s1'], ['w345543-s1'], ['w345545-s1']] },
  { lemma: '탁성', before: [['w343446-s1'], ['w343447-s1']], groups: [['w343446-s1'], ['w343447-s1']] },
  { lemma: '탁탁하다', before: [['w346159-s1'], ['w346159-s2'], ['w346159-s3'], ['w346162-s1'], ['w492779-s1'], ['w492779-s2'], ['w492779-s3']], groups: [['w346159-s1', 'w346159-s2', 'w346159-s3'], ['w346162-s1'], ['w492779-s1', 'w492779-s2', 'w492779-s3']] },
  { lemma: '탈선', before: [['w342133-s1'], ['w493147-s1'], ['w493147-s2'], ['w493147-s3']], groups: [['w342133-s1'], ['w493147-s1', 'w493147-s2', 'w493147-s3']] },
  { lemma: '탈선하다', before: [['w342134-s1'], ['w492562-s1'], ['w492562-s2'], ['w492562-s3']], groups: [['w342134-s1'], ['w492562-s1', 'w492562-s2', 'w492562-s3']] },
  { lemma: '태감', before: [['w338297-s1'], ['w338297-s2'], ['w338300-s1'], ['w496708-s1']], groups: [['w338297-s1'], ['w338297-s2'], ['w338300-s1'], ['w496708-s1']] },
  { lemma: '태반', before: [['w342388-s1'], ['w342389-s1'], ['w342390-s1'], ['w496869-s1']], groups: [['w342388-s1'], ['w342389-s1'], ['w342390-s1'], ['w496869-s1']] },
  { lemma: '택지', before: [['w342560-s1'], ['w342561-s1']], groups: [['w342560-s1'], ['w342561-s1']] },
  { lemma: '토가', before: [['w342756-s1'], ['w342757-s1'], ['w343012-s1']], groups: [['w342756-s1'], ['w342757-s1'], ['w343012-s1']] },
  { lemma: '토향', before: [['w344418-s1'], ['w344419-s1']], groups: [['w344418-s1'], ['w344419-s1']] },
  { lemma: '톳', before: [['w346759-s1'], ['w346982-s1']], groups: [['w346759-s1'], ['w346982-s1']] },
  { lemma: '통발', before: [['w344144-s1'], ['w344145-s1'], ['w492619-s1']], groups: [['w344144-s1'], ['w344145-s1', 'w492619-s1']] },
  { lemma: '통신선', before: [['w349666-s1'], ['w349667-s1']], groups: [['w349666-s1'], ['w349667-s1']] },
  { lemma: '통행권', before: [['w350643-s1'], ['w350643-s2'], ['w350644-s1'], ['w350644-s2']], groups: [['w350643-s1', 'w350643-s2', 'w350644-s1', 'w350644-s2']] },
  { lemma: '탕산', before: [['w341954-s1'], ['w341956-s1'], ['w494544-s1']], groups: [['w341954-s1'], ['w341956-s1'], ['w494544-s1']] },
  { lemma: '탕산하다', before: [['w341955-s1'], ['w497023-s1']], groups: [['w341955-s1'], ['w497023-s1']] },
  { lemma: '토성', before: [['w350201-s1'], ['w350202-s1'], ['w350203-s1'], ['w350204-s1'], ['w350204-s2'], ['w350205-s1'], ['w495559-s1']], groups: [['w350201-s1'], ['w350202-s1'], ['w350203-s1'], ['w350204-s1', 'w350204-s2'], ['w350205-s1'], ['w495559-s1']] },
  { lemma: '토제', before: [['w348249-s1'], ['w348250-s1'], ['w348252-s1'], ['w348253-s1'], ['w348254-s1']], groups: [['w348249-s1'], ['w348250-s1'], ['w348252-s1'], ['w348253-s1'], ['w348254-s1']] },
  { lemma: '통상시', before: [['w347118-s1'], ['w517385-s1']], groups: [['w347118-s1'], ['w517385-s1']] },
  { lemma: '타종', before: [['w341605-s1'], ['w341863-s1'], ['w341864-s1']], priorHeadGroups: [['w341605-s1', 'w341863-s1'], ['w341864-s1']], groups: [['w341605-s1'], ['w341863-s1'], ['w341864-s1']] },
  { lemma: '탐리', before: [['w341678-s1'], ['w341977-s1'], ['w496829-s1']], priorHeadGroups: [['w341678-s1', 'w496829-s1'], ['w341977-s1']], groups: [['w341678-s1'], ['w341977-s1'], ['w496829-s1']] },
  { lemma: '탈거', before: [['w344693-s1'], ['w344693-s2'], ['w344732-s1']], priorHeadGroups: [['w344693-s1', 'w344693-s2', 'w344732-s1']], groups: [['w344693-s1', 'w344693-s2'], ['w344732-s1']] },
  { lemma: '탈거하다', before: [['w344694-s1'], ['w344694-s2'], ['w344733-s1']], priorHeadGroups: [['w344694-s1', 'w344694-s2', 'w344733-s1']], groups: [['w344694-s1', 'w344694-s2'], ['w344733-s1']] },
  { lemma: '퇴경', before: [['w347986-s1'], ['w347988-s1'], ['w347990-s1'], ['w347991-s1'], ['w347991-s2']], priorHeadGroups: [['w347986-s1', 'w347988-s1', 'w347990-s1'], ['w347991-s1'], ['w347991-s2']], groups: [['w347986-s1', 'w347988-s1'], ['w347990-s1'], ['w347991-s1'], ['w347991-s2']] },
  { lemma: '토번', before: [['w348517-s1'], ['w495500-s1']], priorHeadGroups: [['w348517-s1', 'w495500-s1']], groups: [['w348517-s1'], ['w495500-s1']] },
  { lemma: '투광', before: [['w348337-s1'], ['w348602-s1'], ['w497774-s1']], groups: [['w348337-s1'], ['w348602-s1'], ['w497774-s1']] },
  { lemma: '투광하다', before: [['w348601-s1'], ['w348603-s1'], ['w348604-s1']], groups: [['w348601-s1'], ['w348603-s1'], ['w348604-s1']] },
  { lemma: '투구', before: [['w348609-s1'], ['w348611-s1'], ['w348612-s1'], ['w348612-s2'], ['w348614-s1'], ['w495016-s1']], groups: [['w348609-s1'], ['w348611-s1'], ['w348612-s1'], ['w348612-s2'], ['w348614-s1'], ['w495016-s1']] },
  { lemma: '투전', before: [['w350021-s1'], ['w350261-s1'], ['w350263-s1']], groups: [['w350021-s1'], ['w350261-s1'], ['w350263-s1']] },
  { lemma: '티', before: [['w353023-s1'], ['w353023-s2'], ['w353026-s1'], ['w353027-s1'], ['w495437-s1'], ['w495437-s2'], ['w495451-s1'], ['w515511-s1']], groups: [['w353023-s1', 'w353023-s2'], ['w353026-s1'], ['w353027-s1'], ['w495437-s1', 'w495437-s2'], ['w495451-s1'], ['w515511-s1']] },
  { lemma: '탄탄하다', before: [['w346529-s1'], ['w346529-s2'], ['w496633-s1'], ['w496633-s2']], priorHeadGroups: [['w346529-s1', 'w346529-s2', 'w496633-s1', 'w496633-s2']], groups: [['w346529-s1', 'w346529-s2'], ['w496633-s1', 'w496633-s2']] },
  { lemma: '탄탄히', before: [['w346531-s1'], ['w346531-s2'], ['w496632-s1'], ['w496632-s2']], priorHeadGroups: [['w346531-s1', 'w346531-s2', 'w496632-s1', 'w496632-s2']], groups: [['w346531-s1', 'w346531-s2'], ['w496632-s1', 'w496632-s2']] },
  { lemma: '탐미', before: [['w342237-s1'], ['w342239-s1']], priorHeadGroups: [['w342237-s1', 'w342239-s1']], groups: [['w342237-s1'], ['w342239-s1']] },
  { lemma: '탐미하다', before: [['w342238-s1'], ['w342240-s1']], priorHeadGroups: [['w342238-s1', 'w342240-s1']], groups: [['w342238-s1'], ['w342240-s1']] },
  { lemma: '툭탁', before: [['w346931-s1'], ['w347481-s1']], priorHeadGroups: [['w346931-s1', 'w347481-s1']], groups: [['w346931-s1'], ['w347481-s1']] },
  { lemma: '툭탁하다', before: [['w347480-s1'], ['w517686-s1']], priorHeadGroups: [['w347480-s1', 'w517686-s1']], groups: [['w347480-s1'], ['w517686-s1']] },
  { lemma: '툭탁툭탁', before: [['w347497-s1'], ['w517689-s1']], priorHeadGroups: [['w347497-s1', 'w517689-s1']], groups: [['w347497-s1'], ['w517689-s1']] },
  { lemma: '툭탁툭탁하다', before: [['w347498-s1'], ['w517690-s1']], priorHeadGroups: [['w347498-s1', 'w517690-s1']], groups: [['w347498-s1'], ['w517690-s1']] },
  { lemma: '특이성', before: [['w351485-s1'], ['w351485-s2'], ['w351486-s1']], priorHeadGroups: [['w351485-s1', 'w351485-s2', 'w351486-s1']], groups: [['w351485-s1', 'w351485-s2'], ['w351486-s1']] },
];
const sameRecordFigurativeCases = [
  { lemma: '탁방', recordId: 'w342609', recordSenses: ['w342609-s1', 'w342609-s2'], decision: 'merge', reason: 'Exam-pass announcement extends to announcing an outcome or conclusion.', before: [['w342609-s1'], ['w342609-s2']], priorHeadGroups: [['w342609-s1'], ['w342609-s2']], groups: [['w342609-s1', 'w342609-s2']] },
  { lemma: '탁방하다', recordId: 'w342627', recordSenses: ['w342627-s1', 'w342627-s2'], decision: 'merge', reason: 'Posting successful candidates extends to bringing an affair to a conclusion.', before: [['w342627-s1'], ['w342627-s2']], priorHeadGroups: [['w342627-s1'], ['w342627-s2']], groups: [['w342627-s1', 'w342627-s2']] },
  { lemma: '탁방내다', recordId: 'w342628', recordSenses: ['w342628-s1', 'w342628-s2'], decision: 'merge', reason: 'Announcing successful candidates extends to settling an affair.', before: [['w342628-s1'], ['w342628-s2']], priorHeadGroups: [['w342628-s1'], ['w342628-s2']], groups: [['w342628-s1', 'w342628-s2']] },
  { lemma: '탁방나다', recordId: 'w495587', recordSenses: ['w495587-s1', 'w495587-s2'], decision: 'merge', reason: 'The published pass list extends to an affair whose outcome has become clear.', before: [['w495587-s1'], ['w495587-s2']], priorHeadGroups: [['w495587-s1'], ['w495587-s2']], groups: [['w495587-s1', 'w495587-s2']] },
  { lemma: '턱걸이하다', recordId: 'w343654', recordSenses: ['w343654-s1', 'w343654-s2'], decision: 'merge', reason: 'The same-record figurative senses of the paired noun 턱걸이 share the image of barely hanging on, so threshold attainment and depending on another are related uses of one lexical identity.', before: [['w343654-s1'], ['w343654-s2']], priorHeadGroups: [['w343654-s1'], ['w343654-s2']], groups: [['w343654-s1', 'w343654-s2']] },
  { lemma: '태풍의 눈', recordId: 'w342952', recordSenses: ['w342952-s1', 'w342952-s2'], decision: 'merge', reason: 'The calm central region extends to the influential core of a situation through the same center image.', before: [['w342952-s1'], ['w342952-s2']], priorHeadGroups: [['w342952-s1'], ['w342952-s2']], groups: [['w342952-s1', 'w342952-s2']] },
  { lemma: '태산북두', recordId: 'w344356', recordSenses: ['w344356-s1', 'w344356-s2'], decision: 'merge', reason: 'Mount Tai and the Northern Dipper extend metaphorically to a highly respected authority.', before: [['w344356-s1'], ['w344356-s2']], priorHeadGroups: [['w344356-s1'], ['w344356-s2']], groups: [['w344356-s1', 'w344356-s2']] },
  { lemma: '탐화하다', recordId: 'w344729', recordSenses: ['w344729-s1', 'w344729-s2'], decision: 'merge', reason: 'Seeking flowers extends metaphorically to seeking a beloved woman.', before: [['w344729-s1'], ['w344729-s2']], priorHeadGroups: [['w344729-s1'], ['w344729-s2']], groups: [['w344729-s1', 'w344729-s2']] },
  { lemma: '태내', recordId: 'w345014', recordSenses: ['w345014-s1', 'w345014-s2'], decision: 'merge', reason: 'A womb extends metaphorically to the basis from which something arises.', before: [['w345014-s1'], ['w345014-s2']], priorHeadGroups: [['w345014-s1'], ['w345014-s2']], groups: [['w345014-s1', 'w345014-s2']] },
  { lemma: '탄식', recordId: 'w345170', recordSenses: ['w345170-s1', 'w345170-s2'], decision: 'merge', reason: 'Swallowing whole extends to invading and absorbing something; the separate lament homonym remains apart.', before: [['w345170-s1'], ['w345170-s2'], ['w345440-s1']], priorHeadGroups: [['w345170-s1'], ['w345170-s2'], ['w345440-s1']], groups: [['w345170-s1', 'w345170-s2'], ['w345440-s1']] },
  { lemma: '탄식하다', recordId: 'w496434', recordSenses: ['w496434-s1', 'w496434-s2'], decision: 'merge', reason: 'The verb sense extends from swallowing whole to invading and absorbing; the separate lament homonym remains apart.', before: [['w496434-s1'], ['w496434-s2'], ['w496435-s1']], priorHeadGroups: [['w496434-s1'], ['w496434-s2'], ['w496435-s1']], groups: [['w496434-s1', 'w496434-s2'], ['w496435-s1']] },
  { lemma: '터럭', recordId: 'w345570', recordSenses: ['w345570-s1', 'w345570-s2'], decision: 'merge', reason: 'A hair extends metaphorically to something very small or trivial.', before: [['w345570-s1'], ['w345570-s2']], priorHeadGroups: [['w345570-s1'], ['w345570-s2']], groups: [['w345570-s1', 'w345570-s2']] },
  { lemma: '태두', recordId: 'w346110', recordSenses: ['w346110-s1', 'w346110-s2'], decision: 'merge', reason: 'Mount Tai and the Northern Dipper extend metaphorically to a leading authority; the separate kidney homonym remains apart.', before: [['w346109-s1'], ['w346110-s1'], ['w346110-s2']], priorHeadGroups: [['w346109-s1'], ['w346110-s1'], ['w346110-s2']], groups: [['w346109-s1'], ['w346110-s1', 'w346110-s2']] },
  { lemma: '퇴식', recordId: 'w347603', recordSenses: ['w347603-s1', 'w347603-s2', 'w347603-s3'], decision: 'keep', reason: 'Retiring from public office connects to leaving an office for a meal, but clearing a table after eating is a separate action.', before: [['w347364-s1', 'w347603-s1', 'w347603-s2'], ['w347603-s3']], groups: [['w347364-s1', 'w347603-s1', 'w347603-s2'], ['w347603-s3']] },
  { lemma: '투영', recordId: 'w492107', recordSenses: ['w492107-s1', 'w492107-s2', 'w492107-s3', 'w492107-s4'], decision: 'merge', reason: 'Optical, geometric, and psychological projection share the source-bound operation of projecting or reflecting an image, form, or state onto another surface or subject.', before: [['w348055-s1', 'w492107-s1'], ['w348319-s1'], ['w348319-s2'], ['w492107-s2', 'w492107-s4'], ['w492107-s3']], priorHeadGroups: [['w348055-s1', 'w348319-s1', 'w348319-s2', 'w492107-s1'], ['w492107-s2', 'w492107-s4'], ['w492107-s3']], groups: [['w348055-s1', 'w348319-s1', 'w348319-s2', 'w492107-s1', 'w492107-s2', 'w492107-s3', 'w492107-s4']] },
  { lemma: '투영하다', recordId: 'w492108', recordSenses: ['w492108-s1', 'w492108-s2', 'w492108-s3', 'w492108-s4'], decision: 'merge', reason: 'The verb retains the same projection operation across optical, geometric, and psychological uses.', before: [['w348056-s1', 'w492108-s1'], ['w348320-s1'], ['w348320-s2'], ['w492108-s2', 'w492108-s4'], ['w492108-s3']], priorHeadGroups: [['w348056-s1', 'w348320-s1', 'w348320-s2', 'w492108-s1'], ['w492108-s2', 'w492108-s4'], ['w492108-s3']], groups: [['w348056-s1', 'w348320-s1', 'w348320-s2', 'w492108-s1', 'w492108-s2', 'w492108-s3', 'w492108-s4']] },
  { lemma: '퇴식하다', recordId: 'w495919', recordSenses: ['w495919-s1', 'w495919-s2', 'w495919-s3'], decision: 'keep', reason: 'The verb forms likewise connect official retirement and leaving an office for a meal, while clearing the table remains a separate action.', before: [['w347365-s1', 'w495919-s1', 'w495919-s2'], ['w495919-s3']], groups: [['w347365-s1', 'w495919-s1', 'w495919-s2'], ['w495919-s3']] },
  { lemma: '통방', recordId: 'w496280', recordSenses: ['w496280-s1', 'w496280-s2'], decision: 'merge', reason: 'Opening rooms into one continuous space extends figuratively to letters or strokes blended into one indistinguishable whole; 통방하다 w344406-s1 independently confirms the room-opening action, while communication and other homonyms remain separate.', before: [['w346060-s1'], ['w350650-s1'], ['w496264-s1'], ['w496265-s1'], ['w496280-s1'], ['w496280-s2']], priorHeadGroups: [['w346060-s1'], ['w350650-s1'], ['w496264-s1', 'w496280-s1'], ['w496265-s1'], ['w496280-s2']], groups: [['w346060-s1'], ['w350650-s1'], ['w496264-s1', 'w496280-s1', 'w496280-s2'], ['w496265-s1']] },
  { lemma: '토대', recordId: 'w496366', recordSenses: ['w496366-s1', 'w496366-s2', 'w496366-s3'], decision: 'merge', reason: 'A structural base extends to the metaphorical foundation or resources of a matter.', before: [['w496366-s1', 'w496366-s2'], ['w496366-s3']], priorHeadGroups: [['w496366-s1', 'w496366-s2'], ['w496366-s3']], groups: [['w496366-s1', 'w496366-s2', 'w496366-s3']] },
  { lemma: '통양', recordId: 'w496452', recordSenses: ['w496452-s1', 'w496452-s2'], decision: 'merge', reason: 'Pain or itching affecting oneself extends metaphorically to a matter directly affecting one’s own interests.', before: [['w496452-s1'], ['w496452-s2']], priorHeadGroups: [['w496452-s1'], ['w496452-s2']], groups: [['w496452-s1', 'w496452-s2']] },
  { lemma: '토치카', recordId: 'w496463', recordSenses: ['w496463-s1', 'w496463-s2'], decision: 'keep', reason: 'A fortified firing position and an easy-going person have no source-bound identity bridge.', before: [['w496463-s1'], ['w496463-s2']], groups: [['w496463-s1'], ['w496463-s2']] },
  { lemma: '탄토', recordId: 'w496636', recordSenses: ['w496636-s1', 'w496636-s2'], decision: 'merge', reason: 'Swallowing and spitting extend to accepting and releasing things.', before: [['w496636-s1'], ['w496636-s2']], priorHeadGroups: [['w496636-s1'], ['w496636-s2']], groups: [['w496636-s1', 'w496636-s2']] },
  { lemma: '탐화', recordId: 'w496858', recordSenses: ['w496858-s1', 'w496858-s2'], decision: 'merge', reason: 'Seeking flowers extends metaphorically to seeking a beloved woman; the separate historical office homonym remains apart.', before: [['w344730-s1'], ['w496858-s1'], ['w496858-s2']], priorHeadGroups: [['w344730-s1'], ['w496858-s1'], ['w496858-s2']], groups: [['w344730-s1'], ['w496858-s1', 'w496858-s2']] },
  { lemma: '태화탕', recordId: 'w497112', recordSenses: ['w497112-s1', 'w497112-s2', 'w497112-s3'], decision: 'keep', reason: 'The metaphorical carefree state and teasing description of a person share a bridge, but neither is source-bound to boiling water.', before: [['w497112-s1'], ['w497112-s2', 'w497112-s3']], groups: [['w497112-s1'], ['w497112-s2', 'w497112-s3']] },
  { lemma: '태양', recordId: 'w497906', recordSenses: ['w497906-s1', 'w497906-s2'], decision: 'merge', reason: 'The sun extends metaphorically to a precious or hope-giving presence; other homographic records remain separate.', before: [['w343097-s1'], ['w343097-s2'], ['w343098-s1'], ['w343100-s1'], ['w497906-s1'], ['w497906-s2']], priorHeadGroups: [['w343097-s1'], ['w343097-s2'], ['w343098-s1'], ['w343100-s1'], ['w497906-s1'], ['w497906-s2']], groups: [['w343097-s1'], ['w343097-s2'], ['w343098-s1'], ['w343100-s1'], ['w497906-s1', 'w497906-s2']] },
  { lemma: '탄토하다', recordId: 'w337989', recordSenses: ['w337989-s1', 'w337989-s2'], decision: 'merge', reason: 'Swallowing or spitting extends to taking goods in and sending them out.', before: [['w337989-s1'], ['w337989-s2']], priorHeadGroups: [['w337989-s1'], ['w337989-s2']], groups: [['w337989-s1', 'w337989-s2']] },
  { lemma: '태산이 평지 된다', recordId: 'w532602', recordSenses: ['w532602-s1', 'w532602-s2'], decision: 'merge', reason: 'Both proverb glosses describe the same image of radical change, including the transience that follows from it.', before: [['w532602-s1'], ['w532602-s2']], priorHeadGroups: [['w532602-s1'], ['w532602-s2']], groups: [['w532602-s1', 'w532602-s2']] },
  { lemma: '토끼가 제 방귀에 놀란다', recordId: 'w532626', recordSenses: ['w532626-s1', 'w532626-s2'], decision: 'merge', reason: 'Both figurative glosses are conventional readings of the same fixed proverb image, not separate homonyms; preserve the anxiety and frivolous-behavior uses under one expression identity.', before: [['w532626-s1'], ['w532626-s2']], priorHeadGroups: [['w532626-s1'], ['w532626-s2']], groups: [['w532626-s1', 'w532626-s2']] },
];
reviewCases.push(...sameRecordFigurativeCases.filter((item) => item.decision === 'merge'));
const reviewSenseIds = new Set(reviewCases.flatMap(({ groups }) => groups.flat()));
const projectionProbeSenseIds = new Set([
  'w335985-s1', 'w340436-s1', 'w342605-s1', 'w343447-s1', 'w342388-s1', 'w346982-s1',
  'w350643-s1', 'w350644-s1', 'w348611-s1', 'w495016-s1', 'w350261-s1', 'w515511-s1', 'w344145-s1', 'w492619-s1',
  'w341954-s1', 'w341956-s1', 'w341955-s1', 'w497023-s1', 'w517385-s1', 'w357670-s1',
  'w496829-s1', 'w344590-s1',
  'w342237-s1', 'w342239-s1', 'w342238-s1', 'w342240-s1', 'w257330-s1', 'w473250-s1',
  'w351485-s2', 'w351486-s1', 'w348489-s1',
  'w343677-s1', 'w343677-s2', 'w343677-s3', 'w343677-s4', 'w496264-s1', 'w344406-s1',
  'w492107-s1', 'w492107-s2', 'w492107-s3', 'w492107-s4',
  'w492108-s1', 'w492108-s2', 'w492108-s3', 'w492108-s4',
]);
const meaningFiles = readdirSync(meaningDir).filter((file) => /^c17_\d+\.jsonl$/u.test(file)).sort();
const rows = meaningFiles.flatMap((file) => readFileSync(path.join(meaningDir, file), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const rowsByLemma = new Map();
for (const row of rows) {
  const list = rowsByLemma.get(row.lemma) ?? [];
  list.push(row);
  rowsByLemma.set(row.lemma, list);
}
const residualByLemma = new Map([...rowsByLemma].filter(([, list]) => list.length > 1));
const expectedSenseIds = new Set([...residualByLemma.values()].flatMap((list) => list.flatMap((row) => row.sense_ids)));
const senseIdsIn = (text) => [...text.matchAll(/`(w\d+-s\d+)`/gu)].map((match) => match[1]);
const auditPath = path.join(root, 'scripts/meaning/issue-764-c17-residual-audit.md');
const audit = readFileSync(auditPath, 'utf8');
const auditRows = audit.split('\n## 후보 검토 후 하나의 Meaning으로 유지한 기존 다중-sense 항목')[0];
const targetSenseIds = new Set([...auditRows.matchAll(/; resolved — ([^;\n]+); compare — /gu)]
  .flatMap(([, evidence]) => senseIdsIn(evidence)));
const expectedEvidenceIds = new Set([...expectedSenseIds, ...targetSenseIds]);
const identityRegressionSenseIds = new Set([
  'w335349-s1', 'w335633-s1', 'w335634-s1', 'w335635-s1', 'w335636-s1',
  'w335637-s1', 'w342818-s1', 'w489651-s1', 'w489652-s1', 'w489653-s1',
  'w343081-s1', 'w343082-s1', 'w343083-s1', 'w495379-s1', 'w496287-s1', 'w496488-s1',
  'w350459-s1', 'w350460-s1', 'w494494-s1', 'w342772-s1', 'w342772-s2',
  'w345843-s1', 'w345844-s1', 'w345845-s1', 'w349212-s1', 'w349742-s1', 'w495184-s1',
  'w497369-s1', 'w497369-s2', 'w343677-s1', 'w343677-s2', 'w343677-s3', 'w343677-s4', 'w344406-s1',
  'w343346-s1', 'w343346-s2', 'w345436-s1', 'w345436-s2',
  'w496506-s1', 'w496506-s2', 'w496506-s3', 'w497715-s1', 'w296689-s1', 'w347855-s1', 'w347855-s9',
  'w353163-s1', 'w353164-s1',
  ...reviewSenseIds,
  ...sameRecordFigurativeCases.flatMap(({ recordSenses }) => recordSenses),
]);
const meaningIdBySense = new Map(rows.flatMap((row) => row.sense_ids.map((senseId) => [senseId, row.id])));
let sameRecordSplitRecordCount = 0;
const sameRecordSplitLemmas = new Set();
const sourceGlossBySense = new Map();
const identitySourceGlossBySense = new Map();
let tamnaSourceRecord = null;
const projectionSourceRecords = new Map();
const canonicalSourceRecords = new Map();
const projectionTargetSenseIds = new Set();
for (const file of readdirSync(canonicalDir).filter((name) => name.startsWith('stdict-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(path.join(canonicalDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    canonicalSourceRecords.set(entry.id, entry);
    if (entry.id === 'w345436') tamnaSourceRecord = entry;
    if ((entry.senses ?? []).some((sense) => projectionProbeSenseIds.has(sense.id))) {
      projectionSourceRecords.set(entry.id, entry);
      for (const sense of entry.senses ?? []) {
        if (!projectionProbeSenseIds.has(sense.id)) continue;
        for (const relation of sense.relations ?? []) if (relation.target_sense) projectionTargetSenseIds.add(relation.target_sense);
      }
    }
    const splitMeaningIds = new Set((entry.senses ?? []).map((sense) => meaningIdBySense.get(sense.id)).filter(Boolean));
    if (splitMeaningIds.size > 1) {
      sameRecordSplitRecordCount += 1;
      sameRecordSplitLemmas.add(entry.lemma);
    }
    for (const sense of entry.senses ?? []) {
      if (expectedEvidenceIds.has(sense.id)) sourceGlossBySense.set(sense.id, sense.gloss);
      if (identityRegressionSenseIds.has(sense.id)) identitySourceGlossBySense.set(sense.id, sense.gloss);
    }
  }
}
const projectionTargetRows = new Map();
for (const file of readdirSync(meaningDir).filter((name) => /\.jsonl$/u.test(name)).sort()) {
  for (const line of readFileSync(path.join(meaningDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.sense_ids.some((senseId) => projectionTargetSenseIds.has(senseId))) projectionTargetRows.set(row.id, row);
  }
}
const projectionMeanings = [...rows, ...[...projectionTargetRows.values()].filter((row) => !rows.some((c17Row) => c17Row.id === row.id))];
const expectedReferenceMeaningCount = [...residualByLemma.values()].flat()
  .filter((row) => row.sense_ids.some((senseId) => sourceGlossBySense.get(senseId)?.includes('→'))).length;

const short = (value, max) => {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const meaningIdsIn = (text) => [...text.matchAll(/`(m\d+(?:_\d+)?)`/gu)].map((match) => match[1]);

test('C17 residual audit covers every retained Meaning with complete bound-source reasons', () => {
  assert.equal(sourceGlossBySense.size, expectedEvidenceIds.size, 'every bound and referenced target sense must resolve in canonical');
  const expectedLemmas = [...residualByLemma.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
  const headings = [...auditRows.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, expectedLemmas, 'audit must list every and only residual multi-Meaning lemma');
  assert.match(audit, new RegExp(`최종적으로 여러 Meaning을 유지한 ${residualByLemma.size.toLocaleString('en-US')}개 lemma`));

  const seenMeaningIds = [];
  const referencedMeaningIds = [];
  for (let index = 0; index < headings.length; index += 1) {
    const lemma = headings[index];
    const start = auditRows.indexOf(`## ${lemma}\n`);
    const nextHeading = index + 1 < headings.length ? auditRows.indexOf(`## ${headings[index + 1]}\n`, start + 1) : auditRows.length;
    const section = auditRows.slice(start, nextHeading);
    const expectedRows = residualByLemma.get(lemma);
    const entryLines = [...section.matchAll(/^- `(m\d+(?:_\d+)?)` \(([^)]*)\)$/gmu)];
    assert.equal(entryLines.length, expectedRows.length, `${lemma}: every output Meaning needs one audit row`);
    assert.match(section, /^근거 기준: 주 에이전트 source-bound 자체 점검 — .+$/mu, `${lemma}: group-level boundary rationale`);

    const boundTextBySense = new Map();
    const parsedReasons = [];
    for (let rowIndex = 0; rowIndex < expectedRows.length; rowIndex += 1) {
      const row = expectedRows[rowIndex];
      const entry = entryLines[rowIndex];
      const [fullLine, meaningId, renderedSenseIds] = entry;
      seenMeaningIds.push(meaningId);
      assert.equal(meaningId, row.id, `${lemma}: Meaning row order and ID`);
      assert.deepEqual(renderedSenseIds.split(', '), row.sense_ids, `${lemma}/${meaningId}: rendered bound sense IDs`);

      const lineStart = section.indexOf(fullLine);
      const followingLine = section.slice(lineStart + fullLine.length).split('\n')[1];
      assert.ok(followingLine?.startsWith('  - 근거: bound — '), `${lemma}/${meaningId}: reason must immediately follow its Meaning row`);
      const boundMarker = '  - 근거: bound — ';
      const resolvedMarker = '; resolved — ';
      const compareMarker = '; compare — ';
      const conclusionMarker = '; conclusion — ';
      const compareAt = followingLine.indexOf(compareMarker);
      const conclusionAt = followingLine.indexOf(conclusionMarker);
      assert.ok(compareAt > boundMarker.length && conclusionAt > compareAt, `${lemma}/${meaningId}: reason needs bound, compare, and conclusion sections`);
      const resolvedAt = followingLine.indexOf(resolvedMarker);
      const boundEnd = resolvedAt >= 0 ? resolvedAt : compareAt;
      const boundEvidence = followingLine.slice(boundMarker.length, boundEnd);
      const resolvedEvidence = resolvedAt >= 0 ? followingLine.slice(resolvedAt + resolvedMarker.length, compareAt) : '';
      const compareEvidence = followingLine.slice(compareAt + compareMarker.length, conclusionAt);
      const conclusion = followingLine.slice(conclusionAt + conclusionMarker.length).trim();
      assert.ok(conclusion.length > 0, `${lemma}/${meaningId}: row-specific disposition is required`);

      assert.deepEqual(senseIdsIn(boundEvidence), row.sense_ids, `${lemma}/${meaningId}: own bound sources must be complete and ordered`);
      const hasReferenceGloss = row.sense_ids.some((senseId) => sourceGlossBySense.get(senseId).includes('→'));
      if (hasReferenceGloss) {
        referencedMeaningIds.push(meaningId);
        const resolvedSenseIds = senseIdsIn(resolvedEvidence);
        assert.ok(resolvedSenseIds.length > 0, `${lemma}/${meaningId}: reference gloss needs resolved canonical target sense evidence`);
        assert.equal(new Set(resolvedSenseIds).size, resolvedSenseIds.length, `${lemma}/${meaningId}: target senses must not repeat`);
        for (const senseId of resolvedSenseIds) {
          const targetGloss = sourceGlossBySense.get(senseId);
          assert.ok(targetGloss, `${lemma}/${meaningId}: resolved target ${senseId} must exist in canonical`);
          assert.ok(resolvedEvidence.includes(short(targetGloss, 90)), `${lemma}/${meaningId}: resolved target gloss ${senseId}`);
        }
      } else {
        assert.equal(resolvedAt, -1, `${lemma}/${meaningId}: direct source gloss must not have a reference resolution`);
      }
      for (const senseId of row.sense_ids) {
        assert.ok(boundEvidence.includes(short(sourceGlossBySense.get(senseId), 90)), `${lemma}/${meaningId}: bound source gloss ${senseId}`);
        boundTextBySense.set(senseId, boundEvidence);
      }

      const otherRows = expectedRows.filter((other) => other.id !== row.id);
      assert.deepEqual(meaningIdsIn(compareEvidence), otherRows.map((other) => other.id), `${lemma}/${meaningId}: every competing Meaning must be compared`);
      assert.deepEqual(senseIdsIn(compareEvidence), otherRows.flatMap((other) => other.sense_ids), `${lemma}/${meaningId}: every competing source sense must be compared`);
      parsedReasons.push({ meaningId, otherRows, compareEvidence });
    }
    for (const { meaningId, otherRows, compareEvidence } of parsedReasons) {
      for (const senseId of otherRows.flatMap((other) => other.sense_ids)) {
        assert.ok(boundTextBySense.has(senseId), `${lemma}/${meaningId}: comparison source ${senseId} needs its own bound row`);
        assert.ok(boundTextBySense.get(senseId).includes(short(sourceGlossBySense.get(senseId), 90)), `${lemma}/${meaningId}: comparison source gloss ${senseId}`);
        assert.ok(compareEvidence.includes(`\`${senseId}\``), `${lemma}/${meaningId}: comparison cites source ID ${senseId}`);
      }
    }
  }
  assert.equal(new Set(seenMeaningIds).size, seenMeaningIds.length, 'a retained Meaning must appear only once');
  assert.equal(referencedMeaningIds.length, expectedReferenceMeaningCount, 'every reference-bound Meaning must have resolved target evidence');
  assert.deepEqual(seenMeaningIds.sort(), [...residualByLemma.values()].flat().map((row) => row.id).sort(), 'audit/output Meaning ID sets');
});

test('C17 applies naming-principle and distinct-identity boundaries with a one-letter positive control', () => {
  const identityCases = [
    { lemma: '태조', groups: [['w335349-s1', 'w335633-s1', 'w335634-s1', 'w335635-s1', 'w335636-s1', 'w335637-s1', 'w342818-s1', 'w489651-s1', 'w489652-s1', 'w489653-s1']] },
    { lemma: '태종', groups: [['w343081-s1', 'w343082-s1', 'w495379-s1', 'w496287-s1', 'w496488-s1'], ['w343083-s1']] },
    { lemma: '테티스', groups: [['w350459-s1'], ['w350460-s1'], ['w494494-s1']] },
    { lemma: '통고', groups: [['w342772-s1'], ['w342772-s2'], ['w345843-s1'], ['w345844-s1'], ['w345845-s1']] },
    { lemma: '트리톤', groups: [['w349212-s1'], ['w349742-s1'], ['w495184-s1']] },
    { lemma: '티보', groups: [['w353163-s1'], ['w353164-s1']] },
  ];

  for (const { lemma, groups } of identityCases) {
    const meanings = rowsByLemma.get(lemma) ?? [];
    assert.equal(meanings.length, groups.length, `${lemma}: preserve the source-bound identity groups`);
    assert.deepEqual(meanings.map((row) => row.sense_ids).sort((a, b) => a[0].localeCompare(b[0])),
      groups.map((group) => [...group].sort()).sort((a, b) => a[0].localeCompare(b[0])), `${lemma}: exact source-sense grouping`);
    for (const group of groups) {
      const meaning = meanings.find((row) => row.sense_ids.includes(group[0]));
      assert.ok(meaning, `${lemma}/${group.join(',')}: expected Meaning exists`);
      for (const senseId of group) {
        assert.equal(identitySourceGlossBySense.has(senseId), true, `${lemma}/${senseId}: canonical source gloss exists`);
        assert.ok(meaning.sense_ids.includes(senseId), `${lemma}/${senseId}: source sense remains bound`);
      }
      if (group.length === 1) {
        assert.equal(meaning.gloss, identitySourceGlossBySense.get(group[0]), `${lemma}/${group[0]}: source gloss is reproduced exactly`);
      } else {
        assert.equal(meaning.gloss, group.map((senseId) => identitySourceGlossBySense.get(senseId)).join(' '), `${lemma}/${group.join(',')}: all source glosses are preserved in the shared Meaning`);
      }
    }
  }

  const letterMeaning = (rowsByLemma.get('ㅌ') ?? []).find((row) => row.sense_ids.includes('w497369-s1'));
  assert.ok(letterMeaning, 'the Hangul letter positive control remains represented');
  assert.deepEqual(letterMeaning.sense_ids, ['w497369-s1', 'w497369-s2'], 'the letter and its sound are one lexical identity');
  assert.equal(identitySourceGlossBySense.has('w497369-s1') && identitySourceGlossBySense.has('w497369-s2'), true, 'positive-control source senses exist');

  const sturdy = rowsByLemma.get('탄탄하다') ?? [];
  const flatRoad = sturdy.find((row) => row.sense_ids.includes('w496633-s1'));
  const solid = sturdy.find((row) => row.sense_ids.includes('w346529-s1'));
  const sturdyAdverb = rowsByLemma.get('탄탄히') ?? [];
  const flatRoadAdverb = sturdyAdverb.find((row) => row.sense_ids.includes('w346531-s1'));
  const solidAdverb = sturdyAdverb.find((row) => row.sense_ids.includes('w496632-s1'));
  assert.ok(flatRoad && solid && flatRoadAdverb && solidAdverb, '탄탄 adjective and adverb identity groups are present');
  assert.ok(solid.sense_ids.includes('w346529-s2'), 'the physical-sturdiness to organizational-stability positive control stays merged');
  assert.ok(flatRoad.sense_ids.includes('w496633-s2'), 'the flat-road to smooth-future positive control stays merged');
  assert.ok(solidAdverb.sense_ids.includes('w496632-s2'), 'the sturdy to organizational-stability adverb positive control stays merged');
  assert.ok(flatRoadAdverb.sense_ids.includes('w346531-s2'), 'the flat-road to smooth-future adverb positive control stays merged');
  assert.notEqual(solid.id, flatRoad.id, 'physical solidity and level terrain have separate adjective identities');
  assert.notEqual(solidAdverb.id, flatRoadAdverb.id, 'solidity and level terrain have separate adverb identities');

  const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c17.json'), 'utf8'));
  for (const { lemma, before, priorHeadGroups, groups } of reviewCases) {
    const edit = spec.repartitions.find((item) => item.lemma === lemma);
    assert.ok(edit, `${lemma}: the source-bound boundary must replay from the execution spec`);
    assert.deepEqual(edit.before.map((row) => row.sense_ids), before, `${lemma}: record the old split for the regression`);
    assert.deepEqual(edit.groups.map((row) => row.senses), groups, `${lemma}: the revised spec has the expected source-bound groups`);
    const result = rowsByLemma.get(lemma) ?? [];
    assert.deepEqual(result.map((row) => row.sense_ids), groups, `${lemma}: final projection has the reviewed groups`);
    if (priorHeadGroups) {
      assert.notDeepEqual(result.map((row) => row.sense_ids), priorHeadGroups,
        `${lemma}: the erroneous grouping on prior PR HEAD must fail this regression`);
    }
    for (const [index, group] of groups.entries()) {
      assert.equal(result[index].gloss, edit.groups[index].gloss, `${lemma}: emitted gloss matches the recorded execution edit`);
      for (const senseId of group) assert.ok(identitySourceGlossBySense.has(senseId), `${lemma}/${senseId}: canonical source exists`);
    }
  }

  assert.equal(sameRecordFigurativeCases.length, 28, 'the bounded explicit-figurative same-record cohort stays visible');
  for (const item of sameRecordFigurativeCases) {
    const { lemma, recordId, recordSenses, decision, reason, before, priorHeadGroups, groups } = item;
    const record = canonicalSourceRecords.get(recordId);
    assert.ok(record, `${lemma}/${recordId}: candidate source record exists`);
    assert.equal(record.lemma, lemma, `${lemma}/${recordId}: candidate source record matches the lemma`);
    assert.deepEqual(record.senses.map((sense) => sense.id), recordSenses, `${lemma}/${recordId}: scan records the exact canonical source senses`);
    assert.ok(record.senses.some((sense) => /비유적/u.test(sense.gloss)), `${lemma}/${recordId}: cohort entry retains its explicit figurative marker`);
    assert.ok(reason.length > 0, `${lemma}/${recordId}: source-bound decision has a recorded reason`);

    const edit = spec.repartitions.find((candidate) => candidate.lemma === lemma);
    if (decision === 'merge') {
      assert.ok(edit, `${lemma}: accepted same-record merge is present in the execution spec`);
      assert.deepEqual(edit.before.map((row) => row.sense_ids), before, `${lemma}: same-record decision retains its exact baseline snapshot`);
      assert.deepEqual(edit.groups.map((group) => group.senses), groups, `${lemma}: same-record decision is encoded in the execution spec`);
    } else if (edit) {
      const editedRecordGroups = edit.groups.map((group) => group.senses.filter((senseId) => recordSenses.includes(senseId)))
        .filter((group) => group.length > 0);
      const expectedRecordGroups = groups.map((group) => group.filter((senseId) => recordSenses.includes(senseId)))
        .filter((group) => group.length > 0);
      assert.deepEqual(editedRecordGroups, expectedRecordGroups, `${lemma}: any explicit repartition preserves the reviewed source-record boundary`);
    }
    const current = rowsByLemma.get(lemma) ?? [];
    if (decision === 'merge') {
      assert.deepEqual(current.map((row) => row.sense_ids), groups, `${lemma}: same-record decision matches current output`);
    }

    const expectedRecordGroups = groups.map((group) => group.filter((senseId) => recordSenses.includes(senseId))).filter((group) => group.length > 0);
    const actualRecordGroups = [];
    for (const row of current) {
      const group = row.sense_ids.filter((senseId) => recordSenses.includes(senseId));
      if (group.length > 0) actualRecordGroups.push(group);
    }
    assert.deepEqual(actualRecordGroups, expectedRecordGroups, `${lemma}/${recordId}: all record senses follow the reviewed boundary`);
    if (decision === 'merge') {
      assert.ok(priorHeadGroups, `${lemma}: accepted merge records its old failing partition`);
      assert.notDeepEqual(current.map((row) => row.sense_ids), priorHeadGroups, `${lemma}: prior PR partition fails the regression`);
      const merged = current.find((row) => recordSenses.every((senseId) => row.sense_ids.includes(senseId)));
      assert.ok(merged, `${lemma}/${recordId}: the complete source record has one Meaning`);
      assert.equal(merged.gloss, merged.sense_ids.map((senseId) => identitySourceGlossBySense.get(senseId)).join(' '),
        `${lemma}/${recordId}: merged gloss preserves every bound canonical source gloss`);
    } else {
      assert.equal(decision, 'keep', `${lemma}/${recordId}: decision is merge or keep`);
    }
  }

  const projectionNoun = (rowsByLemma.get('투영') ?? []).find((row) => row.sense_ids.includes('w492107-s1'));
  const projectionVerb = (rowsByLemma.get('투영하다') ?? []).find((row) => row.sense_ids.includes('w492108-s1'));
  const projectionNounRecord = projectionSourceRecords.get('w492107');
  const projectionVerbRecord = projectionSourceRecords.get('w492108');
  assert.ok(projectionNoun && projectionVerb && projectionNounRecord && projectionVerbRecord,
    '투영 noun/verb and their canonical records are present');
  for (const senseId of ['w492107-s1', 'w492107-s2', 'w492107-s3', 'w492107-s4']) {
    assert.ok(projectionNoun.sense_ids.includes(senseId), `${senseId}: optical, figurative, geometric and psychological noun uses share one Meaning`);
  }
  for (const senseId of ['w492108-s1', 'w492108-s2', 'w492108-s3', 'w492108-s4']) {
    assert.ok(projectionVerb.sense_ids.includes(senseId), `${senseId}: optical, figurative, geometric and psychological verb uses share one Meaning`);
  }
  const projectionTargets = [
    { record: projectionNounRecord, sourceSense: 'w492107-s1', targetSense: 'w346888-s1', sourceMeaning: projectionNoun },
    { record: projectionNounRecord, sourceSense: 'w492107-s3', targetSense: 'w168172-s2', sourceMeaning: projectionNoun },
    { record: projectionNounRecord, sourceSense: 'w492107-s4', targetSense: 'w492398-s4', sourceMeaning: projectionNoun },
    { record: projectionVerbRecord, sourceSense: 'w492108-s3', targetSense: 'w438577-s2', sourceMeaning: projectionVerb },
    { record: projectionVerbRecord, sourceSense: 'w492108-s4', targetSense: 'w350958-s4', sourceMeaning: projectionVerb },
  ];
  const projectionMeaningRelationResult = projectMeaningRelations({
    records: [projectionNounRecord, projectionVerbRecord],
    meanings: projectionMeanings,
  });
  for (const { sourceSense, targetSense, sourceMeaning } of projectionTargets) {
    const targetMeaning = projectionMeanings.find((row) => row.sense_ids.includes(targetSense));
    assert.ok(targetMeaning, `${targetSense}: direct relation target Meaning exists`);
    const direct = projectionMeaningRelationResult.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaning.id && relation.target_meaning_id === targetMeaning.id
      && relation.sources.some((source) => source.source_sense_id === sourceSense));
    assert.equal(direct.length, 1, `${sourceSense} → ${targetSense}: direct relation reaches the unified Meaning`);
    assert.deepEqual(direct[0].sources.map((source) => source.source_sense_id), [sourceSense],
      `${sourceSense} → ${targetSense}: original canonical source-sense provenance is preserved`);
  }

  const through = (rowsByLemma.get('통하다') ?? []).find((row) => row.sense_ids.includes('w347855-s1'));
  assert.ok(through?.sense_ids.includes('w347855-s9'), 'the physical-through / communication positive control stays in one Meaning');
  const tamnaMeaning = (rowsByLemma.get('탐라') ?? []).find((row) => row.sense_ids.includes('w345436-s1'));
  const tamnaCountryMeaning = (rowsByLemma.get('탐라국') ?? []).find((row) => row.sense_ids.includes('w497715-s1'));
  assert.ok(tamnaSourceRecord && tamnaMeaning && tamnaCountryMeaning, 'the bound Tamna relation endpoints exist');
  assert.equal(identitySourceGlossBySense.get('w345436-s2'), '‘제주도01’의 옛 이름.', 'the canonical reference gloss stays source-bound');
  assert.ok(tamnaMeaning.gloss.includes(identitySourceGlossBySense.get('w296689-s1')), 'the merged gloss preserves the canonical reference target gloss');
  const projection = projectMeaningRelations({
    records: [tamnaSourceRecord],
    meanings: [tamnaMeaning, tamnaCountryMeaning],
  });
  assert.deepEqual(projection.relations.map((relation) => [relation.source_meaning_id, relation.target_meaning_id, relation.type]), [
    [tamnaMeaning.id, tamnaCountryMeaning.id, 'direct'],
  ], 'the canonical Tamna synonym relation still projects after regrouping');
  assert.deepEqual(projection.relations[0].sources, [{
    source_sense_id: 'w345436-s1', source_position: 0, source_redirected: 0, target_redirected: 0,
  }], 'the projected relation retains its canonical source-sense provenance');

  const ordinaryPeriodMeaning = (rowsByLemma.get('통상시') ?? []).find((row) => row.sense_ids.includes('w517385-s1'));
  const ordinaryJudgmentMeaning = (rowsByLemma.get('통상시') ?? []).find((row) => row.sense_ids.includes('w347118-s1'));
  const ordinarySynonymMeaning = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes('w357670-s1'));
  const ordinaryPeriodRecord = projectionSourceRecords.get('w517385');
  const ordinarySynonymRecord = projectionSourceRecords.get('w357670');
  assert.ok(ordinaryPeriodMeaning && ordinaryJudgmentMeaning && ordinarySynonymMeaning
    && ordinaryPeriodRecord && ordinarySynonymRecord, '통상시 source and target Meaning endpoints are present');
  assert.notEqual(ordinaryPeriodMeaning.id, ordinaryJudgmentMeaning.id,
    'the ordinary-time and ordinary-judgment senses have separate Meaning endpoints');
  const ordinaryProjection = projectMeaningRelations({
    records: [ordinaryPeriodRecord, ordinarySynonymRecord],
    meanings: projectionMeanings,
  });
  const periodToSynonym = ordinaryProjection.relations.filter((relation) => relation.type === 'direct'
    && relation.source_meaning_id === ordinaryPeriodMeaning.id
    && relation.target_meaning_id === ordinarySynonymMeaning.id
    && relation.sources.some((source) => source.source_sense_id === 'w517385-s1'));
  const synonymToPeriod = ordinaryProjection.relations.filter((relation) => relation.type === 'direct'
    && relation.source_meaning_id === ordinarySynonymMeaning.id
    && relation.target_meaning_id === ordinaryPeriodMeaning.id
    && relation.sources.some((source) => source.source_sense_id === 'w357670-s1'));
  assert.equal(periodToSynonym.length, 1, '통상시(ordinary time) direct projects to 평상시 in the forward direction');
  assert.equal(synonymToPeriod.length, 1, '평상시 direct projects to 통상시(ordinary time) in the reverse direction');
  assert.deepEqual(periodToSynonym[0].sources.map((source) => source.source_sense_id), ['w517385-s1'],
    'forward direct provenance remains on the ordinary-time source sense');
  assert.deepEqual(synonymToPeriod[0].sources.map((source) => source.source_sense_id), ['w357670-s1'],
    'reverse direct provenance remains on the 평상시 source sense');
  assert.ok(!ordinaryProjection.relations.some((relation) => relation.source_meaning_id === ordinaryJudgmentMeaning.id
    || relation.target_meaning_id === ordinaryJudgmentMeaning.id),
  'the 평상시 direct relation never reaches the ordinary-judgment Meaning');

  const propertyMeaning = (rowsByLemma.get('특이성') ?? []).find((row) => row.sense_ids.includes('w351485-s2'));
  const stellarMeaning = (rowsByLemma.get('특이성') ?? []).find((row) => row.sense_ids.includes('w351486-s1'));
  const characteristicMeaning = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes('w348489-s1'));
  const propertyRecord = projectionSourceRecords.get('w351485');
  const characteristicRecord = projectionSourceRecords.get('w348489');
  assert.ok(propertyMeaning && stellarMeaning && characteristicMeaning && propertyRecord && characteristicRecord,
    '특이성 property/star and 특성 source-bound relation endpoints are present');
  assert.notEqual(propertyMeaning.id, stellarMeaning.id,
    '특이성(性) and 특이성(星) have distinct Meaning identities');
  const specialnessProjection = projectMeaningRelations({
    records: [propertyRecord, characteristicRecord],
    meanings: projectionMeanings,
  });
  for (const { sourceMeaning, targetMeaning, sourceSense } of [
    { sourceMeaning: propertyMeaning, targetMeaning: characteristicMeaning, sourceSense: 'w351485-s2' },
    { sourceMeaning: characteristicMeaning, targetMeaning: propertyMeaning, sourceSense: 'w348489-s1' },
  ]) {
    const direct = specialnessProjection.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaning.id && relation.target_meaning_id === targetMeaning.id
      && relation.sources.some((source) => source.source_sense_id === sourceSense));
    assert.equal(direct.length, 1, `${sourceSense}: 특이성(性) ↔ 특성 direct remains projected`);
    assert.deepEqual(direct[0].sources.map((source) => source.source_sense_id), [sourceSense],
      `${sourceSense}: 특이성(性) ↔ 특성 provenance remains source-bound`);
  }
  assert.ok(!specialnessProjection.relations.some((relation) => relation.source_meaning_id === stellarMeaning.id
    || relation.target_meaning_id === stellarMeaning.id),
  '특이성(性) ↔ 특성 direct never leaks onto the 특이성(星) Meaning');

  const relationCases = [
    { lemma: '탕산', source: 'w341954-s1', other: 'w341956-s1', target: 'w342269-s1' },
    { lemma: '탕산', source: 'w341956-s1', other: 'w341954-s1', target: 'w343275-s1' },
    { lemma: '탕산하다', source: 'w341955-s1', other: 'w497023-s1', target: 'w342270-s1' },
    { lemma: '탕산하다', source: 'w497023-s1', other: 'w341955-s1', target: 'w343521-s1' },
    { lemma: '탐리', source: 'w496829-s1', other: 'w341678-s1', target: 'w344590-s1' },
    { lemma: '타살', source: 'w335985-s1', other: 'w336289-s1', target: 'w38107-s1' },
    { lemma: '타상', source: 'w340436-s1', other: 'w497650-s1', target: 'w494681-s1' },
    { lemma: '탁발하다', source: 'w342605-s1', other: 'w345545-s1', target: 'w141693-s1' },
    { lemma: '탁성', source: 'w343447-s1', other: 'w343446-s1', target: 'w288209-s1' },
    { lemma: '태반', source: 'w342388-s1', other: 'w342389-s1', target: 'w80394-s1' },
    { lemma: '톳', source: 'w346982-s1', other: 'w346759-s1', target: 'w67215-s1' },
    { lemma: '투구', source: 'w348611-s1', other: 'w495016-s1', target: 'w91494-s1' },
    { lemma: '투구', source: 'w495016-s1', other: 'w348611-s1', target: 'w349836-s1' },
    { lemma: '투전', source: 'w350261-s1', other: 'w350263-s1', target: 'w413289-s1' },
    { lemma: '티', source: 'w515511-s1', other: 'w353026-s1', target: 'w353719-s1' },
  ];
  for (const { lemma, source, other, target } of relationCases) {
    const sourceMeaningId = meaningIdBySense.get(source);
    const otherMeaningId = meaningIdBySense.get(other);
    const targetMeaningId = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes(target))?.id
      ?? meaningIdBySense.get(target);
    const sourceRecord = projectionSourceRecords.get(source.split('-')[0]);
    assert.ok(sourceMeaningId && otherMeaningId && targetMeaningId && sourceRecord, `${lemma}: relation probe endpoints are present`);
    assert.notEqual(sourceMeaningId, otherMeaningId, `${lemma}: relation-bearing source is separate from the unlike competing sense`);
    const result = projectMeaningRelations({ records: [sourceRecord], meanings: projectionMeanings });
    const matching = result.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaningId && relation.target_meaning_id === targetMeaningId
      && relation.sources.some((item) => item.source_sense_id === source));
    assert.equal(matching.length, 1, `${lemma}/${source}: source-bound direct relation remains projected`);
    assert.equal(matching[0].sources[0].source_sense_id, source, `${lemma}/${source}: projection provenance stays on its canonical sense`);
    assert.ok(!result.relations.some((relation) => relation.source_meaning_id === otherMeaningId
      && relation.target_meaning_id === targetMeaningId), `${lemma}/${other}: unrelated meaning does not inherit the source relation`);
  }

  const greedyActMeaning = (rowsByLemma.get('탐리') ?? []).find((row) => row.sense_ids.includes('w341678-s1'));
  const greedyOfficialMeaning = (rowsByLemma.get('탐리') ?? []).find((row) => row.sense_ids.includes('w496829-s1'));
  const taxOfficialMeaning = (rowsByLemma.get('탐관') ?? []).find((row) => row.sense_ids.includes('w344590-s1'));
  const greedyOfficialRecord = projectionSourceRecords.get('w496829');
  const taxOfficialRecord = projectionSourceRecords.get('w344590');
  assert.ok(greedyActMeaning && greedyOfficialMeaning && taxOfficialMeaning && greedyOfficialRecord && taxOfficialRecord,
    '탐리/탐관 source-bound relation endpoints are present');
  assert.notEqual(greedyActMeaning.id, greedyOfficialMeaning.id,
    '탐리 “이익을 탐냄” and “탐욕스러운 관리” have distinct Meaning endpoints');
  const greedyProjection = projectMeaningRelations({
    records: [greedyOfficialRecord, taxOfficialRecord],
    meanings: projectionMeanings,
  });
  const greedyOfficialToTaxOfficial = greedyProjection.relations.filter((relation) => relation.type === 'direct'
    && relation.source_meaning_id === greedyOfficialMeaning.id
    && relation.target_meaning_id === taxOfficialMeaning.id
    && relation.sources.some((source) => source.source_sense_id === 'w496829-s1'));
  const taxOfficialToGreedyOfficial = greedyProjection.relations.filter((relation) => relation.type === 'direct'
    && relation.source_meaning_id === taxOfficialMeaning.id
    && relation.target_meaning_id === greedyOfficialMeaning.id
    && relation.sources.some((source) => source.source_sense_id === 'w344590-s1'));
  assert.equal(greedyOfficialToTaxOfficial.length, 1, '탐리 관리 Meaning retains its canonical direct relation to 탐관');
  assert.equal(taxOfficialToGreedyOfficial.length, 1, '탐관 retains its reverse canonical direct relation to 탐리 관리 Meaning');
  assert.deepEqual(greedyOfficialToTaxOfficial[0].sources.map((source) => source.source_sense_id), ['w496829-s1'],
    '탐리 관리 direct provenance stays on its canonical source sense');
  assert.deepEqual(taxOfficialToGreedyOfficial[0].sources.map((source) => source.source_sense_id), ['w344590-s1'],
    '탐관 direct provenance stays on its canonical source sense');
  assert.ok(!greedyProjection.relations.some((relation) => relation.source_meaning_id === greedyActMeaning.id
    || relation.target_meaning_id === greedyActMeaning.id),
  '탐관 direct never leaks onto 탐리 “이익을 탐냄”');

  const tasteNoun = (rowsByLemma.get('탐미') ?? []).find((row) => row.sense_ids.includes('w342237-s1'));
  const beautyNoun = (rowsByLemma.get('탐미') ?? []).find((row) => row.sense_ids.includes('w342239-s1'));
  const tasteVerb = (rowsByLemma.get('탐미하다') ?? []).find((row) => row.sense_ids.includes('w342238-s1'));
  const beautyVerb = (rowsByLemma.get('탐미하다') ?? []).find((row) => row.sense_ids.includes('w342240-s1'));
  const beautyNounSynonym = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes('w257330-s1'));
  const beautyVerbSynonym = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes('w473250-s1'));
  const beautyRecords = ['w342239', 'w342240', 'w257330', 'w473250'].map((id) => projectionSourceRecords.get(id));
  assert.ok(tasteNoun && beautyNoun && tasteVerb && beautyVerb && beautyNounSynonym && beautyVerbSynonym
    && beautyRecords.every(Boolean), '탐미 taste/beauty and 유미 source-bound relation endpoints are present');
  assert.notEqual(tasteNoun.id, beautyNoun.id, 'taste and beauty noun identities stay separate');
  assert.notEqual(tasteVerb.id, beautyVerb.id, 'taste and beauty verb identities stay separate');
  const beautyProjection = projectMeaningRelations({ records: beautyRecords, meanings: projectionMeanings });
  for (const { sourceSense, targetSense, sourceMeaning, targetMeaning } of [
    { sourceSense: 'w342239-s1', targetSense: 'w257330-s1', sourceMeaning: beautyNoun, targetMeaning: beautyNounSynonym },
    { sourceSense: 'w257330-s1', targetSense: 'w342239-s1', sourceMeaning: beautyNounSynonym, targetMeaning: beautyNoun },
    { sourceSense: 'w342240-s1', targetSense: 'w473250-s1', sourceMeaning: beautyVerb, targetMeaning: beautyVerbSynonym },
    { sourceSense: 'w473250-s1', targetSense: 'w342240-s1', sourceMeaning: beautyVerbSynonym, targetMeaning: beautyVerb },
  ]) {
    const matching = beautyProjection.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaning.id && relation.target_meaning_id === targetMeaning.id
      && relation.sources.some((source) => source.source_sense_id === sourceSense));
    assert.equal(matching.length, 1, `${sourceSense} ↔ ${targetSense}: canonical beauty direct relation projects in both directions`);
    assert.deepEqual(matching[0].sources.map((source) => source.source_sense_id), [sourceSense],
      `${sourceSense}: beauty direct relation keeps its original source-sense provenance`);
    assert.ok(targetMeaning.sense_ids.includes(targetSense), `${targetSense}: beauty relation remains bound to its target Meaning`);
  }
  const tasteMeaningIds = new Set([tasteNoun.id, tasteVerb.id]);
  assert.ok(!beautyProjection.relations.some((relation) => tasteMeaningIds.has(relation.source_meaning_id)
    || tasteMeaningIds.has(relation.target_meaning_id)), '유미/유미하다 direct relations never leak onto taste-only Meaning identities');

  for (const { lemma, source, coGrouped, target } of [
    { lemma: '통발', source: 'w344145-s1', coGrouped: 'w492619-s1', target: 'w228082-s1' },
    { lemma: '통행권', source: 'w350643-s1', coGrouped: 'w350644-s1', target: 'w350651-s1' },
  ]) {
    const sourceMeaningId = meaningIdBySense.get(source);
    const coGroupedMeaningId = meaningIdBySense.get(coGrouped);
    const targetMeaningId = [...projectionTargetRows.values()].find((row) => row.sense_ids.includes(target))?.id
      ?? meaningIdBySense.get(target);
    const sourceRecord = projectionSourceRecords.get(source.split('-')[0]);
    const coGroupedRecord = projectionSourceRecords.get(coGrouped.split('-')[0]);
    assert.ok(sourceMeaningId && coGroupedMeaningId && targetMeaningId && sourceRecord && coGroupedRecord,
      `${lemma}: merged relation endpoints are present`);
    assert.equal(sourceMeaningId, coGroupedMeaningId, `${lemma}: the naturally extended senses share one Meaning`);
    const result = projectMeaningRelations({ records: [sourceRecord, coGroupedRecord], meanings: projectionMeanings });
    const matching = result.relations.filter((relation) => relation.type === 'direct'
      && relation.source_meaning_id === sourceMeaningId && relation.target_meaning_id === targetMeaningId);
    assert.equal(matching.length, 1, `${lemma}/${source}: canonical direct relation still projects after merging`);
    assert.deepEqual(matching[0].sources.map((item) => item.source_sense_id), [source],
      `${lemma}/${source}: the direct relation keeps only its original canonical sense provenance`);
  }
});

test('C17 tracks the same-record split risk cohort after source-bound corrections', () => {
  // The pre-follow-up baseline had 332 split records across 316 lemmas; this is a candidate count, not an error count.
  assert.equal(sameRecordSplitRecordCount, 306);
  assert.equal(sameRecordSplitLemmas.size, 290);
  for (const senseId of ['w343346-s1', 'w345436-s1', 'w496506-s1', 'w345148-s1', 'w345148-s2']) {
    assert.ok(meaningIdBySense.has(senseId), `${senseId}: reviewed same-record source sense remains in C17`);
  }
});

test('paired figurative forms and the same proverbial expression keep their related uses together', () => {
  const chinPullNoun = (rowsByLemma.get('턱걸이') ?? []).find((row) => row.sense_ids.includes('w343677-s1'));
  const chinPullVerb = (rowsByLemma.get('턱걸이하다') ?? []).find((row) => row.sense_ids.includes('w343654-s1'));
  assert.ok(chinPullNoun && chinPullVerb, '턱걸이 noun and verb source-bound meanings are present');
  assert.deepEqual(chinPullNoun.sense_ids, ['w343677-s1', 'w343677-s2', 'w343677-s3', 'w343677-s4'],
    'the paired noun keeps both figurative senses with the physical image');
  assert.deepEqual(chinPullVerb.sense_ids, ['w343654-s1', 'w343654-s2'],
    'the paired verb keeps its threshold and dependency uses together');
  assert.equal(chinPullVerb.gloss, ['w343654-s1', 'w343654-s2'].map((id) => identitySourceGlossBySense.get(id)).join(' '),
    'the paired verb preserves both exact canonical source glosses');
  assert.match(identitySourceGlossBySense.get('w343677-s3'), /기준에 겨우 미침/u);
  assert.match(identitySourceGlossBySense.get('w343677-s4'), /남에게 의지하여 지냄/u);

  const openPlanNoun = (rowsByLemma.get('통방') ?? []).find((row) => row.sense_ids.includes('w496280-s2'));
  const openPlanVerb = (rowsByLemma.get('통방하다') ?? []).find((row) => row.sense_ids.includes('w344406-s1'));
  const codedCommunicationVerb = (rowsByLemma.get('통방하다') ?? []).find((row) => row.sense_ids.includes('w344405-s1'));
  assert.ok(openPlanNoun && openPlanVerb && codedCommunicationVerb, '통방 noun and both verb homonyms are present');
  assert.deepEqual(openPlanNoun.sense_ids, ['w496264-s1', 'w496280-s1', 'w496280-s2'],
    'the open-room sense and its figurative blended-glyph extension share one noun Meaning');
  assert.notEqual(openPlanVerb.id, codedCommunicationVerb.id,
    'opening rooms remains separate from coded communication between cells');
  assert.equal(identitySourceGlossBySense.get('w344406-s1'), '두 칸 이상의 방을 터 놓다.');

  const proverb = (rowsByLemma.get('토끼가 제 방귀에 놀란다') ?? []).find((row) => row.sense_ids.includes('w532626-s1'));
  assert.ok(proverb, 'the canonical proverb Meaning is present');
  assert.deepEqual(proverb.sense_ids, ['w532626-s1', 'w532626-s2'],
    'both source gloss readings of the same fixed proverb remain one expression identity');
  assert.equal(proverb.gloss, ['w532626-s1', 'w532626-s2'].map((id) => identitySourceGlossBySense.get(id)).join(' '),
    'the proverb Meaning preserves both exact source glosses');
});
