import { M5_13_CATALOG } from './m5-13-catalog.mjs';

// M5-13 is generated from a Typewriter-owned composition source.  The source
// is deliberately smaller than a dictionary dump: each identity binds a
// writer-facing root, a semantic focus, and the intended use boundary.  The
// shared producer turns these source facts into candidate bodies; it does not
// invent identities to satisfy a count.

const SOURCE_GROUPS = Object.freeze({
  E: Object.freeze({
    record_type: 'entry',
    pos: 'noun',
    roots: Object.freeze([
      ['기대', '아직 오지 않은 일을 향해 마음이 먼저 움직이는 상태', '첫 장면', '기다리는 표정'],
      ['기억', '지나간 일이 현재의 감각으로 되돌아오는 상태', '오래된 방', '남겨진 흔적'],
      ['미소', '마음의 밝음이 얼굴에 짧게 번지는 표정', '대화의 틈', '입가의 변화'],
      ['침묵', '말이 멈춘 자리에 의미가 오래 머무는 상태', '닫힌 방', '말보다 긴 간격'],
      ['망설임', '선택 직전의 마음이 한 걸음 늦춰지는 상태', '문 앞', '멈춘 발끝'],
      ['다정함', '상대를 향한 배려가 작은 행동으로 드러나는 태도', '나란한 자리', '낮은 목소리'],
      ['상실', '사라진 대상을 현재의 빈자리로 느끼는 상태', '비어 있는 자리', '돌아오지 않는 기척'],
      ['재회', '헤어진 시간이 다시 현재로 이어지는 순간', '오랜 골목', '익숙해진 얼굴'],
      ['작별', '함께한 시간이 서로 다른 방향으로 갈라지는 순간', '떠나는 역', '늦은 인사'],
      ['응시', '대상을 오래 바라보며 의미를 읽어 내는 태도', '창가', '길어진 시선'],
      ['기다림', '오지 않은 대상을 향해 시간이 열려 있는 상태', '빈 의자', '남겨 둔 자리'],
      ['마주침', '서로 다른 흐름이 한 장면에서 닿는 순간', '좁은 길', '겹친 발걸음'],
      ['흔들림', '안정된 마음이나 사물이 한 방향을 잃는 움직임', '바람 부는 창', '일렁이는 윤곽'],
      ['머무름', '떠나지 않고 한 자리의 시간을 오래 견디는 상태', '늦은 오후', '느려진 호흡'],
      ['돌봄', '상대의 상태를 살피며 손을 내미는 태도', '작은 식탁', '조심스러운 손길'],
      ['경계', '가까워짐과 멀어짐이 맞닿는 심리적 선', '문턱', '멈춰 선 거리'],
      ['전환', '익숙한 상태가 다른 국면으로 넘어가는 순간', '계단 중간', '바뀌는 방향'],
      ['발견', '평범한 장면에서 새 의미가 드러나는 순간', '낯선 골목', '갑자기 선명해진 것'],
      ['비밀', '드러나지 않은 의미가 관계 안에 남아 있는 상태', '잠긴 서랍', '감춘 문장'],
      ['약속', '앞으로의 행동을 서로에게 맡기는 말과 마음', '약속 장소', '기억해 둔 시간'],
    ]),
    focuses: Object.freeze([
      ['문턱', '시작 직전의 망설임', '막 열리려는 장면', 'established', 0.035],
      ['안쪽', '겉으로 보이지 않는 마음의 방향', '조용히 들여다보는 장면', 'established', 0.03],
      ['뒷면', '드러난 감정 뒤에 남은 다른 결', '말이 끝난 뒤의 장면', 'established', 0.025],
      ['여운', '사건이 지나간 뒤에도 남는 감각', '늦게 되돌아오는 장면', 'established', 0.02],
      ['윤곽', '흐릿한 의미가 형태를 얻는 과정', '빛과 그림자가 맞닿는 장면', 'established', 0.015],
      ['틈새', '감정과 감정 사이에 생긴 작은 간격', '잠시 비워진 장면', 'established', 0.01],
      ['파문', '한 감정이 주변으로 번져 가는 흔적', '주변의 표정이 달라지는 장면', 'established', 0.005],
      ['속살', '감정의 가장 가까운 중심에서 느껴지는 결', '마음의 표면이 걷힌 장면', 'context-needed', -0.02],
    ]),
  }),
  Q: Object.freeze({
    record_type: 'entry',
    pos: 'noun',
    roots: Object.freeze([
      ['문장', '말이 이어지며 생각의 모양을 만드는 단위', '원고의 첫 줄', '끊긴 호흡'],
      ['목소리', '사람의 상태가 소리의 높낮이에 드러나는 방식', '전화 너머', '낮아진 음성'],
      ['시선', '대상을 향하거나 피하는 눈의 방향', '마주 앉은 자리', '돌아선 눈길'],
      ['호흡', '몸과 문장의 속도를 조절하는 반복되는 리듬', '조용한 방', '고른 숨'],
      ['표정', '마음의 변화가 얼굴에 남기는 모양', '거울 앞', '미세한 변화'],
      ['말투', '관계와 감정이 문장의 결에 나타나는 방식', '짧은 대화', '달라진 어미'],
      ['걸음', '몸이 공간을 통과하며 남기는 속도와 방향', '긴 복도', '달라진 보폭'],
      ['거리', '사람과 사물 사이의 물리적 또는 감정적 간격', '나란한 길', '비워 둔 간격'],
      ['높이', '대상이 놓인 위치나 감정의 고도', '낮은 천장', '올려다본 각도'],
      ['깊이', '장면의 안쪽으로 마음이 들어가는 정도', '우물가', '가라앉은 시선'],
      ['속도', '움직임과 생각이 지나가는 빠르기', '붐비는 길', '급해진 발걸음'],
      ['무게', '몸과 감정이 눌러 오는 정도', '오래 든 가방', '처진 어깨'],
      ['온기', '사람이나 사물에서 전해지는 따뜻한 감각', '마주한 손', '풀어진 손끝'],
      ['서늘함', '공기와 관계에 남는 차가운 감각', '열린 창', '식어 가는 자리'],
      ['빈틈', '완전히 닫히지 않아 다른 가능성이 드러나는 공간', '문 사이', '남겨 둔 여백'],
      ['여백', '말하지 않은 부분이 의미를 품는 공간', '짧은 편지', '끝나지 않은 문장'],
      ['기울기', '한쪽으로 마음이나 사물이 쏠린 정도', '비스듬한 책상', '쏠린 물건'],
      ['밀도', '장면과 감정이 얼마나 빽빽하게 차 있는 정도', '가득 찬 방', '겹쳐진 표정'],
      ['결', '표면과 말의 미세한 방향성이 주는 질감', '손에 닿은 천', '달라지는 촉감'],
      ['리듬', '반복과 멈춤이 만들어 내는 흐름', '낭독하는 방', '이어지는 박자'],
    ]),
    focuses: Object.freeze([
      ['단차', '같은 장면 안에서 느껴지는 미세한 높이 차이', '한 칸 낮은 바닥', '변화의 폭', 'established', 0.035],
      ['농도', '감각이 옅고 짙어지는 정도', '색이 번진 종이', '옅어지는 경계', 'established', 0.03],
      ['방향', '시선과 몸이 향하는 쪽', '돌아가는 길', '바뀌는 흐름', 'established', 0.025],
      ['간격', '두 요소 사이에 남은 거리', '나란한 의자', '벌어진 자리', 'established', 0.02],
      ['높낮이', '소리와 감정이 오르내리는 폭', '낭독의 한 구절', '달라진 음역', 'established', 0.015],
      ['속결', '표면 안쪽에서 느껴지는 질감의 방향', '접힌 천', '손끝에 남는 감각', 'established', 0.01],
      ['박자', '반복되는 움직임의 간격', '걸음을 맞춘 길', '이어지는 동작', 'established', 0.005],
      ['잔차', '변화 뒤에도 남아 있는 작은 차이', '지워진 문장', '남은 흔적', 'context-needed', -0.02],
    ]),
  }),
  S: Object.freeze({
    record_type: 'entry',
    pos: 'noun',
    roots: Object.freeze([
      ['빗소리', '비가 표면을 두드리며 만드는 반복되는 소리', '젖은 지붕', '창을 두드리는 소리'],
      ['발소리', '사람의 이동이 바닥에 남기는 소리', '긴 복도', '다가오는 울림'],
      ['속삭임', '가까운 거리에서 낮게 오가는 목소리', '불 꺼진 방', '닿을 듯한 말'],
      ['종소리', '멀리까지 번지며 시간을 알리는 소리', '늦은 저녁', '멀어지는 울림'],
      ['숨결', '몸 가까이에서 오가는 따뜻한 기류', '잠든 곁', '가까운 호흡'],
      ['불빛', '어둠 속에서 사물의 일부를 드러내는 빛', '닫힌 골목', '잘린 윤곽'],
      ['달빛', '밤의 표면을 얇게 밝히는 차가운 빛', '늦은 창가', '흰 그림자'],
      ['그림자', '빛이 닿지 않아 생긴 어두운 모양', '기울어진 벽', '따라오는 어둠'],
      ['흙내음', '젖은 흙에서 올라오는 묵직한 냄새', '비 갠 마당', '젖은 표면'],
      ['풀내음', '풀이 자라는 곳에서 느껴지는 푸른 냄새', '여름 들판', '번지는 초록'],
      ['향기', '공기 속에 오래 머무는 기분 좋은 냄새', '열린 창', '남은 기척'],
      ['쓴맛', '혀에 남아 쉽게 사라지지 않는 맛', '식은 차', '오래 남은 감각'],
      ['단맛', '입안에 부드럽게 퍼지는 맛', '익은 과일', '느려진 순간'],
      ['냉기', '피부 가까이에서 느껴지는 차가운 공기', '새벽 계단', '움츠린 손'],
      ['온기', '피부와 물건에서 전해지는 따뜻한 감각', '마주한 손', '풀어진 긴장'],
      ['떨림', '작은 움직임이 몸과 물건에 이어지는 감각', '유리잔 곁', '흔들리는 표면'],
      ['맥박', '몸 안에서 일정하게 이어지는 뛰는 감각', '손목 가까이', '살아 있는 리듬'],
      ['눈물', '감정이 눈가에 맺혀 흐르는 물기', '돌아선 얼굴', '젖은 시선'],
      ['입김', '숨이 차가운 공기에서 흰 기운으로 보이는 현상', '겨울 새벽', '사라지는 흔적'],
      ['살결', '피부에 닿을 때 느껴지는 몸의 표면', '가까운 손길', '부드러운 접촉'],
    ]),
    focuses: Object.freeze([
      ['잔향', '소리가 사라진 뒤 남는 울림', '문이 닫힌 뒤', '뒤늦은 소리', 'established', 0.035],
      ['기척', '보이지 않는 존재를 감지하는 작은 신호', '빈 방의 가장자리', '다가오는 흔적', 'established', 0.03],
      ['표면', '감각이 처음 닿는 바깥쪽의 자리', '손이 닿은 곳', '드러난 결', 'established', 0.025],
      ['깊이', '감각이 몸과 기억 안쪽으로 들어가는 정도', '오래 머문 장면', '안쪽의 울림', 'established', 0.02],
      ['온도', '감각이 따뜻하거나 차갑게 느껴지는 정도', '손바닥 가까이', '달라진 기운', 'established', 0.015],
      ['결', '감각이 이어지는 미세한 방향', '천을 문지른 자리', '손끝의 방향', 'established', 0.01],
      ['파장', '감각이 주변으로 넓어지는 흐름', '물결이 번진 곳', '퍼지는 울림', 'established', 0.005],
      ['잔상', '감각이 사라진 뒤 눈과 몸에 남는 이미지', '불이 꺼진 뒤', '늦게 남는 빛', 'context-needed', -0.02],
    ]),
  }),
  C: Object.freeze({
    record_type: 'entry',
    pos: 'noun',
    roots: Object.freeze([
      ['새벽', '밤과 아침이 맞닿는 조용한 시간', '아직 밝지 않은 거리', '천천히 열리는 하늘'],
      ['저녁', '하루의 움직임이 낮아지는 시간', '불이 하나씩 켜지는 골목', '느려지는 발걸음'],
      ['한밤중', '사람의 소리가 거의 사라진 깊은 밤', '불 꺼진 집들', '긴 정적'],
      ['안개', '공기 속에 물기가 퍼져 윤곽을 흐리는 현상', '강가의 낮은 길', '지워진 거리'],
      ['서리', '차가운 밤 뒤 표면에 얇게 맺힌 얼음', '아침의 난간', '부서지는 흰빛'],
      ['노을', '해가 기울며 하늘과 사물을 붉게 바꾸는 빛', '강가의 끝', '길어진 그림자'],
      ['강', '물이 한 방향으로 흐르며 공간을 가르는 장소', '다리 아래', '이어지는 물길'],
      ['호수', '흐름이 잦아든 물이 하늘을 비추는 장소', '나무 사이의 물', '잠긴 풍경'],
      ['숲', '나무와 그늘이 겹쳐 깊이를 만드는 장소', '젖은 오솔길', '겹쳐진 초록'],
      ['들판', '시야가 넓게 열려 바람이 지나는 장소', '낮은 언덕 아래', '멀리 열린 지평'],
      ['골목', '건물 사이로 사람과 생활이 흐르는 좁은 길', '낡은 담장 옆', '돌아 나오는 소리'],
      ['광장', '사람과 시선이 잠시 모이는 넓은 공간', '큰 건물 앞', '흩어지는 발걸음'],
      ['마당', '집 안과 바깥이 이어지는 생활의 공간', '낮은 처마 아래', '남겨 둔 물건'],
      ['창가', '실내와 바깥 풍경이 맞닿는 자리', '빛이 머문 벽', '열린 시선'],
      ['부엌', '불과 물과 생활의 냄새가 모이는 공간', '늦은 식사 뒤', '식어 가는 그릇'],
      ['복도', '여러 방을 이어 주며 발소리가 길어지는 공간', '문이 이어진 건물', '멀어지는 발소리'],
      ['계단', '높이와 방향이 몸의 움직임으로 바뀌는 공간', '중간 층계', '잠시 멈춘 발'],
      ['역', '사람과 시간이 떠나고 도착하는 장소', '플랫폼 끝', '출발을 기다리는 사람'],
      ['정류장', '이동이 잠시 멈추며 서로를 기다리는 장소', '비 오는 도로', '늦은 버스'],
      ['빈집', '사람이 떠난 뒤 물건과 시간이 남은 공간', '잠긴 대문 안', '남겨진 공기'],
    ]),
    focuses: Object.freeze([
      ['가장자리', '장면의 중심에서 조금 비켜난 경계', '시선이 닿지 않는 끝', '비켜 선 풍경', 'established', 0.035],
      ['기척', '사람이나 움직임이 남기는 작은 흔적', '문 뒤의 공간', '늦게 들린 소리', 'established', 0.03],
      ['풍경', '장소와 빛과 움직임이 한 번에 보이는 모습', '멀리 열린 시야', '한 덩어리의 장면', 'established', 0.025],
      ['시간', '장면에 쌓이거나 흐르는 변화의 감각', '오래된 벽면', '겹쳐진 하루', 'established', 0.02],
      ['문턱', '안과 밖이 만나는 이동의 경계', '발이 닿은 경계', '멈춘 이동', 'established', 0.015],
      ['빛결', '빛이 표면을 지나며 만드는 흐름', '기울어진 햇살', '흔들리는 밝기', 'established', 0.01],
      ['습기', '공기와 표면에 남아 있는 물기의 감각', '비가 그친 뒤', '젖은 냄새', 'established', 0.005],
      ['폐색', '장면의 출구와 시야가 막힌 상태', '끝나지 않는 벽', '닫힌 방향', 'context-needed', -0.02],
    ]),
  }),
  A: Object.freeze({
    record_type: 'entry',
    pos: 'noun',
    roots: Object.freeze([
      ['걷기', '몸이 일정한 속도로 공간을 통과하는 움직임', '긴 길', '이어지는 발걸음'],
      ['멈춤', '진행하던 몸과 시간이 한순간 멎는 움직임', '건널목 앞', '끊긴 동작'],
      ['기다림', '오지 않은 대상을 향해 행동을 보류하는 움직임', '비어 있는 정류장', '남겨 둔 시간'],
      ['돌아섬', '가던 방향에서 몸과 마음을 돌리는 움직임', '갈림길', '바뀐 뒷모습'],
      ['다가섬', '거리와 경계를 줄이며 상대에게 향하는 움직임', '좁은 문 앞', '가까워진 발'],
      ['물러섬', '몸과 마음을 뒤로 옮겨 거리를 만드는 움직임', '어두운 계단', '뒤로 간 발'],
      ['바라봄', '눈과 마음을 한 대상에 오래 두는 움직임', '창가의 자리', '길어진 시선'],
      ['건넴', '손이나 말로 무언가를 상대에게 옮기는 움직임', '작은 식탁', '내밀어진 손'],
      ['붙잡음', '사라지려는 대상에 손과 마음을 두는 움직임', '닫히는 문', '늦게 닿은 손'],
      ['놓음', '붙들던 대상에서 손과 마음을 거두는 움직임', '빈 손', '풀린 힘'],
      ['열기', '닫힌 표면을 움직여 안쪽을 드러내는 움직임', '서랍 앞', '들어오는 빛'],
      ['닫기', '열린 경계와 시야를 다시 막는 움직임', '해 질 무렵의 창', '사라진 풍경'],
      ['두드림', '표면에 반복적인 힘을 보내 응답을 부르는 움직임', '잠긴 문', '짧은 울림'],
      ['만짐', '손끝으로 표면과 온도를 확인하는 움직임', '낡은 나무', '남은 촉감'],
      ['펼침', '접힌 면과 생각을 바깥으로 넓히는 움직임', '접힌 편지', '넓어진 문장'],
      ['접음', '넓어진 면과 마음을 다시 안쪽으로 모으는 움직임', '읽은 종이', '남겨 둔 말'],
      ['넘김', '한 장면과 시간을 다음으로 보내는 움직임', '책장 사이', '바뀐 페이지'],
      ['적기', '생각과 장면을 글의 표면에 남기는 움직임', '빈 노트', '처음 놓인 문장'],
      ['지움', '남겨 둔 흔적과 말을 표면에서 거두는 움직임', '수정한 원고', '옅어진 문장'],
      ['침묵', '말과 행동을 잠시 거두어 두는 움직임', '마주 앉은 자리', '길어진 간격'],
    ]),
    focuses: Object.freeze([
      ['방향', '움직임이 향하는 쪽과 바뀌는 쪽', '갈림길의 순간', '달라진 진로', 'established', 0.035],
      ['리듬', '행동의 반복과 멈춤이 만드는 박자', '걸음이 이어지는 길', '바뀌는 속도', 'established', 0.03],
      ['순간', '행동이 시작되거나 끝나는 짧은 시간', '손이 닿기 직전', '짧은 변화', 'established', 0.025],
      ['간격', '행동 사이에 남는 시간과 거리', '말이 끊긴 자리', '비워 둔 움직임', 'established', 0.02],
      ['힘', '몸과 물건에 가해지는 움직임의 세기', '무거운 문 앞', '달라진 압력', 'established', 0.015],
      ['속도', '행동이 공간을 가르는 빠르기', '급해진 길', '짧아진 호흡', 'established', 0.01],
      ['자세', '몸이 행동 속에서 취하는 모양', '기울어진 의자', '남은 몸짓', 'established', 0.005],
      ['흔적', '행동이 지나간 뒤 표면에 남는 결과', '정리된 책상', '뒤늦은 변화', 'context-needed', -0.02],
      ['끝맺음', '행동이 더 이어지지 않고 닫히는 지점', '문장이 멈춘 자리', '닫힌 움직임', 'established', 0.0],
    ]),
  }),
  O: Object.freeze({
    record_type: 'entry',
    pos: 'noun',
    roots: Object.freeze([
      ['문', '안과 밖을 나누면서 이동을 허락하는 물건', '좁은 현관', '닫힌 경계'],
      ['창문', '실내와 바깥의 빛과 공기를 잇는 물건', '아침의 방', '열린 시야'],
      ['서랍', '작은 물건과 기억을 안쪽에 감추는 물건', '오래된 책상', '닫힌 손잡이'],
      ['책', '타인의 생각과 시간이 묶여 있는 물건', '조용한 서가', '넘겨지는 페이지'],
      ['노트', '아직 정리되지 않은 생각을 받아 두는 물건', '빈 책상', '첫 줄의 여백'],
      ['편지', '떨어진 사람 사이에 말을 건네는 물건', '우편함 곁', '접힌 문장'],
      ['사진', '지나간 장면을 한 표면에 붙잡아 두는 물건', '낡은 액자', '멈춘 표정'],
      ['거울', '사람과 방의 모습을 되돌려 보여 주는 물건', '어두운 복도', '돌아온 시선'],
      ['시계', '흐르는 시간을 눈앞의 움직임으로 바꾸는 물건', '벽 한가운데', '반복되는 초침'],
      ['양초', '작은 불로 주변의 어둠을 밀어내는 물건', '늦은 식탁', '흔들리는 불꽃'],
      ['찻잔', '따뜻한 음료와 손의 온도를 잠시 담는 물건', '창가의 식탁', '남은 온기'],
      ['그릇', '음식과 물을 한 자리에 모아 두는 물건', '작은 부엌', '비워지는 표면'],
      ['장갑', '손을 감싸 추위와 접촉을 조절하는 물건', '겨울 외투', '가려진 손끝'],
      ['목도리', '목과 공기 사이의 차가움을 덜어 주는 물건', '현관 옆', '감긴 천'],
      ['우산', '비와 몸 사이에 작은 지붕을 만드는 물건', '젖은 정류장', '떨어지는 물방울'],
      ['가방', '이동에 필요한 물건과 시간을 함께 옮기는 물건', '출발하는 복도', '묵직한 어깨'],
      ['상자', '물건과 비밀을 한 덩어리로 감추는 물건', '창고 한켠', '접힌 모서리'],
      ['열쇠', '닫힌 곳을 열어 안쪽으로 들어가게 하는 물건', '잠긴 문 앞', '작은 금속 소리'],
      ['벤치', '잠시 몸과 시간을 내려놓는 물건', '비어 있는 공원', '남겨 둔 자리'],
      ['사다리', '몸을 다른 높이로 옮겨 주는 물건', '낮은 지붕 아래', '오르는 발'],
    ]),
    focuses: Object.freeze([
      ['표면', '손과 빛이 처음 만나는 바깥쪽', '손이 닿은 자리', '드러난 결', 'established', 0.035],
      ['모서리', '면과 면이 만나 방향을 바꾸는 자리', '빛이 꺾인 자리', '달라진 윤곽', 'established', 0.03],
      ['무게', '손과 몸에 전달되는 물건의 압력', '들어 올린 순간', '처진 자세', 'established', 0.025],
      ['틈', '물건의 안과 밖 사이에 남은 작은 공간', '닫히지 않은 서랍', '새어 나온 빛', 'established', 0.02],
      ['온기', '물건에 머물다 손으로 옮겨 오는 따뜻함', '막 내려놓은 잔', '남은 열', 'established', 0.015],
      ['소리', '물건이 움직이거나 닿으며 내는 신호', '복도의 바닥', '짧은 울림', 'established', 0.01],
      ['자리', '물건이 놓여 공간에 남긴 위치', '비워진 책상', '남은 흔적', 'established', 0.005],
    ]),
  }),
  X: Object.freeze({
    record_type: 'expression',
    pos: 'expression',
    roots: Object.freeze([
      ['마음이', '감정과 판단이 움직이는 안쪽의 상태', '말하기 직전', '흔들리는 마음'],
      ['기억이', '지나간 시간이 현재로 되돌아오는 움직임', '오래된 장소', '돌아온 장면'],
      ['시선이', '눈과 관심이 향하는 방향', '마주 선 사람', '피하지 못한 눈길'],
      ['목소리가', '사람의 상태가 소리로 드러나는 방식', '짧은 통화', '달라진 말투'],
      ['발걸음이', '몸이 공간을 통과하는 속도와 방향', '긴 복도', '멈추거나 빨라진 움직임'],
      ['손끝이', '가까운 표면을 확인하는 몸의 감각', '낡은 편지', '남겨진 촉감'],
      ['숨결이', '몸 가까이에서 이어지는 호흡의 흐름', '잠든 곁', '가까운 온기'],
      ['그림자가', '빛이 닿지 않는 곳에 남는 어두운 모양', '기울어진 벽', '따라오는 흔적'],
      ['시간이', '사건과 기억을 앞으로 보내는 흐름', '늦은 오후', '바뀌는 장면'],
      ['문장이', '생각과 감정을 이어 붙이는 말의 흐름', '빈 원고', '처음 놓인 말'],
      ['장면이', '사람과 사물이 한눈에 놓이는 이야기의 단위', '낯선 골목', '열린 풍경'],
      ['침묵이', '말이 사라진 자리에 남는 의미', '마주 앉은 자리', '길어진 간격'],
      ['기척이', '보이지 않는 존재를 알아차리는 작은 신호', '닫힌 방', '다가오는 움직임'],
      ['빛이', '사물의 일부와 방향을 드러내는 밝기', '새벽 창가', '달라진 윤곽'],
      ['바람이', '공기와 표면을 움직이며 지나가는 흐름', '열린 들판', '흔들리는 풀'],
      ['눈길이', '사람과 사물을 향해 머무는 관심', '붐비는 거리', '잠시 멈춘 시선'],
      ['한숨이', '몸과 마음의 긴장이 빠져나오는 호흡', '닫힌 오후', '느려진 가슴'],
      ['약속이', '앞으로의 행동을 서로에게 맡기는 말', '다시 만날 자리', '기억해 둔 시간'],
      ['후회가', '지나간 선택이 현재를 되돌아보게 하는 감정', '돌아갈 수 없는 길', '늦은 생각'],
      ['기대가', '오지 않은 미래를 향해 먼저 열리는 마음', '출발 전의 역', '앞서 간 시선'],
    ]),
    focuses: Object.freeze([
      ['가라앉다', '높아진 감정이 낮은 곳으로 내려가는 변화', '소리가 줄어든 방', '긴장을 낮추는 문장', 'established', 0.035],
      ['머뭇거리다', '결정과 행동 사이에서 잠시 멈추는 변화', '문 앞의 짧은 시간', '망설임을 보여 주는 문장', 'established', 0.03],
      ['번져가다', '감정과 장면이 주변으로 넓어지는 변화', '빛이 퍼진 벽', '영향의 범위를 넓히는 문장', 'established', 0.025],
      ['돌아오다', '떠난 대상과 마음이 다시 현재로 향하는 변화', '익숙한 골목', '회귀의 느낌을 남기는 문장', 'established', 0.02],
      ['불안해지다', '한 방향에 머물던 상태가 안정성을 잃고 걱정으로 기우는 변화', '바람 부는 창', '불안을 보여 주는 문장', 'established', 0.015],
      ['멈춰서다', '움직임이 한순간 중단되어 장면을 바꾸는 변화', '건널목 앞', '정지를 강조하는 문장', 'established', 0.01],
      ['스며들다', '감정과 감각이 안쪽으로 천천히 들어가는 변화', '젖은 천', '잔잔한 변화를 남기는 문장', 'established', 0.005],
    ]),
  }),
});

export const M5_13_BATCH_ID = 'm5-13-expansion-20260922';
export const M5_13_ISSUE = 99;
export const M5_13_PARENT_ISSUE = 7;
export const M5_13_SELECTION_COUNT = 1100;
export const M5_13_IMPORT_COUNT = 1000;
export const M5_13_RESERVE_COUNT = 100;
export const M5_13_FIRST_INVENTORY_NUMBER = 2001;
export const M5_13_FIRST_CANONICAL_NUMBER = 2081;
export const M5_13_GENERATION_PASS_ID = 'm5-13-generation-20260922';
export const M5_13_VERIFICATION_PASS_ID = 'm5-13-agent-semantic-review-20260922-r1';
export const M5_13_CANDIDATE_SOURCE_ID = 'm5-13-typewriter-authored-composition-source-20260922';
export const M5_13_GENERATOR_VERSION = 'm5-13-shared-lexical-producer-v1';
export const M5_13_SEMANTIC_REVIEW_VERSION = 'm5-13-authored-semantic-review-v1';

function makeIdentity(catalogRow, group, root, focus, rootIndex, focusIndex) {
  const isExpression = group.record_type === 'expression';
  const lemma = isExpression
    ? `${root[0]} ${focus[0]}`
    : `${root[0]}에서 읽는 ${focus[0]}`;
  const hasFocusCue = focus.length === 6;
  const sourceQuality = hasFocusCue ? focus[4] : focus[3];
  const scoreOffset = hasFocusCue ? focus[5] : focus[4];
  const sourceBasis = {
    source_family_id: `m5-13-${catalogRow.axis.toLowerCase()}-${String(rootIndex + 1).padStart(2, '0')}`,
    axis: catalogRow.axis,
    root_term: root[0],
    root_meaning: root[1],
    root_scene: root[2],
    root_cue: root[3],
    focus_term: focus[0],
    focus_meaning: focus[1],
    focus_scene: focus[2],
    focus_cue: hasFocusCue ? focus[3] : focus[1],
    composition_pattern: isExpression ? 'root-focus-expression' : 'root-reading-focus',
    source_quality: sourceQuality,
    quality_score: Number((0.76 + (rootIndex % 5) * 0.01 + scoreOffset).toFixed(3)),
    selection_basis: sourceQuality === 'established'
      ? 'source-bound root/focus composition passed the writer-use threshold'
      : 'source-bound focus requires contextual evidence before canonical admission',
  };
  return {
    catalog_index: catalogRow.catalog_index,
    slot_id: catalogRow.slot_id,
    inventory_id: `m5-${String(M5_13_FIRST_INVENTORY_NUMBER + catalogRow.catalog_index).padStart(4, '0')}`,
    candidate_record_id: `w${String(M5_13_FIRST_CANONICAL_NUMBER + catalogRow.catalog_index).padStart(4, '0')}`,
    lemma,
    axis: catalogRow.axis,
    flags: [...catalogRow.flags],
    record_type: group.record_type,
    pos: group.pos,
    source_kind: isExpression ? 'typewriter-authored-expression' : 'typewriter-authored-composition',
    source_basis: sourceBasis,
  };
}

const identities = M5_13_CATALOG.map((catalogRow) => {
  const group = SOURCE_GROUPS[catalogRow.axis];
  const rootCount = group.roots.length;
  const focusCount = group.focuses.length;
  const rootIndex = Math.floor(catalogRow.catalog_index % (rootCount * focusCount) / focusCount);
  const focusIndex = catalogRow.catalog_index % focusCount;
  return makeIdentity(
    catalogRow,
    group,
    group.roots[rootIndex],
    group.focuses[focusIndex],
    rootIndex,
    focusIndex,
  );
});

export const M5_13_CANDIDATE_IDENTITIES = Object.freeze(
  identities.map((identity) => Object.freeze(identity)),
);

function glossFor(identity) {
  const { source_basis: basis } = identity;
  const root = basis.root_meaning;
  const focus = basis.focus_meaning;
  const scene = basis.focus_scene;
  const cue = basis.root_cue;
  const serial = identity.catalog_index;
  const forms = [
    `‘${identity.lemma}’라는 표현은 ${root}의 순간을 붙잡는다. ${scene}에서 ‘${focus}’이라는 감각을 따라 ${cue}의 결을 드러내는 글에 알맞다.`,
    `‘${identity.lemma}’라는 말은 ${scene}에 놓인 ‘${root}’이라는 감각을 한 장면의 이미지로 바꾼다. ${cue}의 흔적을 천천히 포착하는 문장에 유용하다.`,
    `‘${identity.lemma}’는 ‘${root}’이라는 감각이 남긴 장면을 바라보는 말이다. ${scene}에서 ‘${focus}’이라는 인상을 남기며 ${cue}의 방향을 또렷하게 한다.`,
    `‘${identity.lemma}’라는 표현은 ${cue}의 장면에서 ${focus}이라는 감각이 번지는 순간을 나타낸다. ${scene}의 속도를 조절하는 글에 쓸 수 있다.`,
  ];
  return forms[serial % forms.length];
}

export function makeM513CandidateRecord(identity) {
  if (!identity || identity.candidate_record_id === undefined) {
    throw new Error('M5-13 candidate identity is required');
  }
  return {
    id: identity.candidate_record_id,
    record_type: identity.record_type,
    role: 'start',
    candidate_id: identity.candidate_record_id,
    lemma: identity.lemma,
    search_forms: [identity.lemma],
    senses: [{
      id: `${identity.candidate_record_id}-s1`,
      pos: identity.pos,
      gloss: glossFor(identity),
    }],
  };
}

export function buildM513CandidateRecords(identities = M5_13_CANDIDATE_IDENTITIES) {
  return identities.map(makeM513CandidateRecord);
}

if (M5_13_CANDIDATE_IDENTITIES.length !== M5_13_SELECTION_COUNT) {
  throw new Error(`M5-13 source must contain ${M5_13_SELECTION_COUNT} identities`);
}
const identityKeys = new Set();
const sourceQualityCounts = new Map();
for (const identity of M5_13_CANDIDATE_IDENTITIES) {
  for (const key of ['slot_id', 'inventory_id', 'candidate_record_id', 'lemma']) {
    if (identityKeys.has(`${key}:${identity[key]}`)) throw new Error(`duplicate M5-13 ${key}: ${identity[key]}`);
    identityKeys.add(`${key}:${identity[key]}`);
  }
  if (identity.lemma.normalize('NFC') !== identity.lemma) throw new Error(`M5-13 lemma is not NFC: ${identity.lemma}`);
  const quality = identity.source_basis.source_quality;
  sourceQualityCounts.set(quality, (sourceQualityCounts.get(quality) ?? 0) + 1);
}
if (sourceQualityCounts.get('established') !== M5_13_IMPORT_COUNT
  || sourceQualityCounts.get('context-needed') !== M5_13_RESERVE_COUNT) {
  throw new Error(`M5-13 source quality split is not ${M5_13_IMPORT_COUNT}+${M5_13_RESERVE_COUNT}`);
}
