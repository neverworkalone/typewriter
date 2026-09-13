// Typewriter-authored M5-11 lexical catalog.
//
// This is the reviewed staging source for the bounded +500 batch.  It is not
// read by the runtime or dictionary builder; the batch builder turns these
// rows into canonical JSONL only after the manifest and validation gates pass.

function parseGroup(axis, defaultFlag, text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [lemma, pos, gloss] = line.split('\t');
      if (!lemma || !pos || !gloss) {
        throw new Error(`invalid M5-11 catalog row: ${line}`);
      }
      return {
        lemma,
        pos,
        gloss,
        axis,
        flags: [pos === 'expression' ? 'expression-unit' : defaultFlag],
      };
    });
}

const groups = [
  parseGroup('E', 'mood-range', `
가책\tnoun\t잘못을 저질렀다고 느끼는 마음의 부담
감회\tnoun\t지난 일을 떠올릴 때 밀려오는 느낌
감응\tnoun\t대상에 마음이 움직여 반응하는 일
경탄\tnoun\t훌륭하거나 놀라운 대상을 보고 느끼는 감탄
경이\tnoun\t낯설고 놀라운 대상을 마주한 마음
고뇌\tnoun\t해결하기 어려운 문제로 깊이 괴로워하는 마음
고심\tnoun\t방법을 찾느라 마음을 많이 쓰는 일
괴로움\tnoun\t몸이나 마음이 견디기 힘든 상태
낭패감\tnoun\t일이 뜻대로 되지 않아 난처한 느낌
낙관\tnoun\t앞일을 밝게 내다보는 태도
난감함\tnoun\t어찌할 방법을 찾기 어려운 난처한 마음
망연자실\tnoun\t정신이 멍해져 아무 생각도 하기 어려운 상태
무력감\tnoun\t스스로 할 수 있는 일이 없다고 느끼는 마음
배신감\tnoun\t믿던 대상에게 저버림을 당했다고 느끼는 마음
부담감\tnoun\t맡은 일이나 상황이 무겁게 느껴지는 마음
불신감\tnoun\t상대나 상황을 믿기 어렵다고 느끼는 마음
상심\tnoun\t마음이 상하고 슬퍼진 상태
소외감\tnoun\t무리에서 떨어져 있다고 느끼는 마음
애도\tnoun\t잃은 대상을 슬퍼하며 기리는 마음
애착\tnoun\t대상에 오래 마음을 붙이고 아끼는 감정
애석함\tnoun\t아깝고 안타깝게 여기는 마음
열망\tnoun\t무언가를 간절히 바라는 마음
오해\tnoun\t사실과 다르게 받아들인 생각
원한\tnoun\t풀리지 않은 미움과 서운함
위축감\tnoun\t기세가 꺾여 자신이 작아진 듯한 느낌
자괴감\tnoun\t자신을 못났다고 여기는 괴로운 마음
자긍심\tnoun\t자신이나 일을 가치 있게 여기는 마음
적개심\tnoun\t상대를 적대하려는 강한 마음
전전긍긍\tnoun\t두려워하며 안절부절못하는 상태
절실함\tnoun\t무언가가 꼭 필요하고 간절한 정도
정감\tnoun\t대상에서 따뜻하게 느껴지는 친근한 마음
정서\tnoun\t사람의 마음에 일어나는 감정의 흐름
친근감\tnoun\t가깝고 편하게 느끼는 마음
평정\tnoun\t흔들림 없이 차분한 마음
환멸\tnoun\t기대가 무너져 몹시 싫어지는 마음
황홀\tnoun\t아름답거나 기쁜 일에 넋을 잃은 상태
환호\tnoun\t기쁘거나 반가워 큰 소리로 외치는 반응
회의감\tnoun\t믿거나 확신하기 어려운 의심의 느낌
흥분\tnoun\t감정이나 기운이 크게 올라온 상태
흥미\tnoun\t대상에 마음이 끌리는 관심
동질감\tnoun\t서로 같은 편이라고 느끼는 마음
만족\tnoun\t바라던 상태에 이르러 흡족한 마음
안심\tnoun\t걱정이 풀려 마음을 놓는 상태
미안함\tnoun\t상대에게 잘못했다는 마음
죄의식\tnoun\t잘못을 저질렀다고 스스로 판단하는 마음
부끄러움\tnoun\t잘못이나 부족함이 드러나 수줍고 괴로운 마음
의기소침\tnoun\t기운이 꺾여 풀이 죽은 상태
의욕\tnoun\t어떤 일을 하고 싶어 하는 기운
염려\tnoun\t앞일을 걱정하며 마음 쓰는 일
걱정\tnoun\t일이 잘못될까 마음을 쓰는 상태
조급함\tnoun\t서두르고 싶어 마음이 가라앉지 않는 상태
두근거림\tnoun\t가슴이 빠르게 뛰는 듯한 긴장이나 설렘
떨림\tnoun\t몸이나 마음이 가늘게 흔들리는 느낌
소명감\tnoun\t해야 할 일을 맡았다고 느끼는 마음
책임감\tnoun\t맡은 일을 다해야 한다고 느끼는 마음
감사\tnoun\t고마움을 느끼고 표현하는 마음
격앙\tnoun\t감정이 세차게 치솟은 상태
격정\tnoun\t억누르기 어려울 만큼 강한 감정
분개\tnoun\t부당한 일을 보고 몹시 화내는 마음
원통함\tnoun\t억울하고 분하여 풀리지 않는 마음
황망함\tnoun\t갑작스러운 일로 정신이 어지러운 느낌
숙연함\tnoun\t분위기나 마음이 엄숙하고 조용해진 상태
참담함\tnoun\t일이 비참하게 무너져 느끼는 막막한 마음
처연함\tnoun\t쓸쓸하고 가련한 느낌
처절함\tnoun\t몹시 처참하고 절박한 상태
고양감\tnoun\t기분이나 의욕이 높아진 느낌
들뜸\tnoun\t마음이 가라앉지 않고 가벼워진 상태
결핍감\tnoun\t무언가 모자란다고 느끼는 마음
연민감\tnoun\t남의 아픔을 안타깝게 여기는 마음
온정\tnoun\t따뜻하게 보살피려는 마음
냉소\tnoun\t비웃거나 믿지 않는 차가운 태도
비애\tnoun\t깊고 서글픈 슬픔
비탄\tnoun\t큰 슬픔에 잠긴 상태
통쾌함\tnoun\t막힌 일이 풀려 시원한 느낌
유쾌함\tnoun\t기분이 즐겁고 상쾌한 상태
불길함\tnoun\t나쁜 일이 생길 듯한 느낌
위기감\tnoun\t위험이 닥쳤다고 느끼는 긴박한 마음
당혹\tnoun\t갑작스러운 일로 어찌할 바를 모르는 상태
신중함\tnoun\t서두르지 않고 살피는 마음
마음고생\tnoun\t걱정이나 어려움으로 겪는 정신적 고통
`),
  parseGroup('Q', 'direct-boundary', `
가지런하다\tadjective\t흩어지지 않고 고르게 정돈되어 있다
간결하다\tadjective\t군더더기 없이 짧고 분명하다
강렬하다\tadjective\t느낌이나 인상이 매우 세다
개운하다\tadjective\t답답함이 풀려 산뜻하고 편안하다
건장하다\tadjective\t몸이 튼튼하고 기운이 있다
겸손하다\tadjective\t자신을 낮추고 남을 존중하다
고단하다\tadjective\t몸과 마음이 지쳐 힘들다
고집스럽다\tadjective\t자기 생각을 쉽게 굽히지 않다
공손하다\tadjective\t말과 행동이 예의 바르다
과묵하다\tadjective\t말수가 적고 속내를 잘 드러내지 않다
괴팍하다\tadjective\t성격이나 행동이 괴상하고 까다롭다
근면하다\tadjective\t부지런하고 꾸준히 힘을 쓰다
기민하다\tadjective\t눈치가 빠르고 동작이나 판단이 재빠르다
날렵하다\tadjective\t몸놀림이나 모양이 가볍고 재빠르다
낭만적이다\tadjective\t현실보다 정서와 상상을 중요하게 여기다
냉랭하다\tadjective\t태도나 분위기가 차갑고 다정하지 않다
단출하다\tadjective\t차림이나 구성이 간단하고 소박하다
대담하다\tadjective\t겁내지 않고 과감하게 행동하다
도도하다\tadjective\t자신을 높여 쉽게 어울리지 않다
둔감하다\tadjective\t자극이나 변화를 빠르게 느끼지 못하다
든든하다\tadjective\t의지가 되거나 마음이 안정되다
따뜻하다\tadjective\t온도나 태도가 포근하고 다정하다
똑똑하다\tadjective\t판단과 이해가 빠르고 영리하다
명료하다\tadjective\t내용이나 모양이 분명하고 알아보기 쉽다
무감각하다\tadjective\t느낌이나 자극에 거의 반응하지 않다
무례하다\tadjective\t예의가 없고 상대를 배려하지 않다
무르익다\tverb\t일이나 분위기가 충분히 깊어지다
방만하다\tadjective\t규율 없이 풀어져 정돈되지 않다
번잡하다\tadjective\t사람이나 일이 많아 어수선하고 복잡하다
보잘것없다\tadjective\t두드러진 가치나 볼품이 없다
분명하다\tadjective\t모호하지 않고 뚜렷하다
불그스름하다\tadjective\t빛깔이 조금 붉다
비겁하다\tadjective\t용기가 없고 떳떳하지 못하다
비범하다\tadjective\t보통보다 뛰어나고 특별하다
사려 깊다\tadjective\t남의 처지와 일을 깊이 헤아리다
산뜻하다\tadjective\t기분이나 모양이 깨끗하고 가볍다
상냥하다\tadjective\t말과 태도가 부드럽고 친절하다
선량하다\tadjective\t성품이 착하고 남을 해치지 않다
성나다\tadjective\t화가 나서 감정이 거칠어지다
순박하다\tadjective\t꾸밈이 없고 성질이 순하다
신기하다\tadjective\t평소와 달라 새롭고 놀랍다
싱겁다\tadjective\t맛이나 분위기가 자극적이지 않고 심심하다
아늑하다\tadjective\t포근하고 편안하여 마음이 놓이다
아담하다\tadjective\t작지만 모양이 단정하고 알맞다
애매하다\tadjective\t분명하지 않고 경계가 흐리다
야속하다\tadjective\t정이 없고 섭섭하게 느껴지다
억세다\tadjective\t기운이나 성질이 매우 세다
엄숙하다\tadjective\t분위기나 태도가 조용하고 무겁다
어리둥절하다\tadjective\t갑작스러운 일로 얼떨떨하다
여유롭다\tadjective\t서두르지 않고 넉넉한 기분이 있다
오만하다\tadjective\t자신을 높이고 남을 낮춰 보다
우울하다\tadjective\t기분이 가라앉고 마음이 무겁다
위태롭다\tadjective\t위험하여 안심하기 어렵다
유쾌하다\tadjective\t기분이 즐겁고 상쾌하다
의젓하다\tadjective\t말과 행동이 점잖고 믿음직하다
자비롭다\tadjective\t남을 너그럽게 용서하고 돕다
잔잔하다\tadjective\t움직임이나 감정이 세지 않고 고요하다
장엄하다\tadjective\t크고 엄숙하여 위엄이 있다
절박하다\tadjective\t상황이 매우 급하고 여유가 없다
정직하다\tadjective\t거짓이나 숨김이 없이 바르다
조용하다\tadjective\t소리나 움직임이 크지 않다
착하다\tadjective\t마음씨가 곱고 남을 해치지 않다
청명하다\tadjective\t날씨나 빛이 맑고 깨끗하다
초라하다\tadjective\t낡고 보잘것없어 초라한 느낌을 주다
충실하다\tadjective\t내용이나 맡은 일을 알차게 갖추다
친절하다\tadjective\t남을 배려하고 따뜻하게 대하다
칠흑같다\tadjective\t빛이 거의 없어 아주 캄캄하다
탁하다\tadjective\t빛이나 소리가 맑지 않고 흐리다
풍성하다\tadjective\t양이나 내용이 넉넉하고 많다
한가롭다\tadjective\t바쁘지 않고 느긋한 상태이다
허약하다\tadjective\t몸이나 기운이 약하다
현명하다\tadjective\t사리를 분별하고 지혜롭게 판단하다
호탕하다\tadjective\t마음이 넓고 시원스럽다
화사하다\tadjective\t빛이나 모습이 밝고 곱다
황량하다\tadjective\t비어 있고 쓸쓸한 느낌이 들다
훈훈하다\tadjective\t따뜻하고 정다운 기운이 있다
울퉁불퉁하다\tadjective\t표면이 고르지 않고 높낮이가 있다
오돌토돌하다\tadjective\t작은 돌기나 알갱이가 돋아 있다
촘촘하다\tadjective\t틈이 거의 없이 빽빽하다
정숙하다\tadjective\t말과 행동이 조용하고 삼가다
`),
  parseGroup('S', 'sensory-transfer', `
가루\tnoun\t잘게 부서진 알갱이
가슬가슬하다\tadjective\t표면이 거칠고 마른 느낌이 있다
거품\tnoun\t액체에 생긴 둥근 기포
구릿내\tnoun\t구리나 오래된 금속에서 나는 냄새
까끌까끌하다\tadjective\t만졌을 때 거칠고 매끄럽지 않다
깔깔하다\tadjective\t목이나 표면이 거칠고 메마른 느낌이 있다
꽃향기\tnoun\t꽃에서 풍기는 향긋한 냄새
노린내\tnoun\t짐승이나 기름에서 나는 비릿한 냄새
눈부심\tnoun\t강한 빛 때문에 눈이 부신 느낌
눈송이\tnoun\t눈이 내릴 때 떨어지는 작은 얼음 결정
달다\tadjective\t설탕처럼 단맛이 느껴지다
맑다\tadjective\t빛이나 소리가 흐리지 않고 깨끗하다
맑음\tnoun\t흐림 없이 깨끗한 상태
매끄럽다\tadjective\t표면이 거칠지 않고 부드럽다
모락모락하다\tadjective\t김이나 연기가 가볍게 피어오르다
무지개\tnoun\t비 뒤 햇빛에 여러 색으로 보이는 띠
미각\tnoun\t맛을 느끼는 감각
미세하다\tadjective\t아주 작고 섬세하다
바람소리\tnoun\t바람이 스치며 내는 소리
박하향\tnoun\t박하처럼 시원하게 느껴지는 향
반사광\tnoun\t다른 표면에 부딪혀 되비치는 빛
반투명하다\tadjective\t빛은 통하지만 속이 또렷이 보이지 않다
발광\tnoun\t물체가 스스로 빛을 내는 현상
밝기\tnoun\t빛이 밝게 느껴지는 정도
보랏빛\tnoun\t보라색을 띤 빛깔
분홍빛\tnoun\t분홍색을 띤 빛깔
붉은빛\tnoun\t붉은색으로 보이는 빛깔
비누향\tnoun\t비누처럼 깨끗하고 알칼리성인 향
빛깔\tnoun\t빛이 드러내는 색의 느낌
사각거림\tnoun\t마른 것이 스칠 때 나는 가벼운 소리
상큼하다\tadjective\t맛이나 향이 산뜻하고 가볍다
서걱거림\tnoun\t마른 표면이 서로 스치는 소리
선홍빛\tnoun\t맑고 선명한 붉은색의 빛깔
소금기\tnoun\t소금처럼 짠맛을 띠는 기운
소금물\tnoun\t소금이 녹아 짠맛이 나는 물
송진\tnoun\t소나무에서 배어 나오는 끈끈한 물질
수증기\tnoun\t물이 기체로 변해 공기 중에 퍼진 것
시큼함\tnoun\t신맛이 느껴지는 정도
신기루\tnoun\t멀리서 실제처럼 보이는 빛의 착시
신선하다\tadjective\t오래되지 않아 맑고 생생하다
아지랑이\tnoun\t따뜻한 공기가 아른거리며 피어오르는 현상
안개비\tnoun\t안개처럼 가늘게 내리는 비
알싸함\tnoun\t코나 혀를 톡 쏘는 듯한 느낌
얼음장\tnoun\t얼음처럼 차갑고 단단한 표면
여울\tnoun\t물이 얕고 빠르게 흐르는 곳
온습\tnoun\t따뜻함과 습기가 함께 느껴지는 기운
옅다\tadjective\t빛깔이나 농도가 진하지 않다
잔향\tnoun\t소리나 냄새가 사라진 뒤 남는 느낌
조명\tnoun\t공간이나 대상을 비추는 빛
짙다\tadjective\t빛깔이나 냄새가 강하고 진하다
찬바람\tnoun\t차갑게 느껴지는 바람
찬기운\tnoun\t주변이나 몸에서 느껴지는 차가운 기운
청량하다\tadjective\t맑고 시원하여 상쾌하다
초록빛\tnoun\t초록색으로 보이는 빛깔
콸콸거리다\tverb\t물이 세차게 흐르는 소리를 내다
향취\tnoun\t특정한 대상에서 느껴지는 향기
후각\tnoun\t냄새를 맡아 느끼는 감각
훈기\tnoun\t따뜻하게 느껴지는 기운
흰빛\tnoun\t하얀색으로 보이는 빛깔
흐린빛\tnoun\t선명하지 않고 흐릿한 빛
오돌토돌함\tnoun\t작은 돌기가 돋은 표면의 느낌
서늘한기운\tnoun\t차갑고 가라앉은 듯한 기운
부스러기\tnoun\t부서져 생긴 작은 조각
빛무리\tnoun\t빛을 둘러싸고 번지는 둥근 무리
빛살\tnoun\t사방으로 뻗어 나가는 빛의 줄기
물방울\tnoun\t작게 맺힌 한 방울의 물
물비린내\tnoun\t물이나 생물에서 나는 비릿한 냄새
바람내음\tnoun\t바람을 타고 전해지는 냄새
잔물결\tnoun\t수면에 작게 일어나는 물결
파문\tnoun\t물결이 둥글게 퍼져 나가는 흔적
투명도\tnoun\t속이 비쳐 보이는 정도
차가운빛\tnoun\t차갑고 멀게 느껴지는 빛의 인상
따뜻한빛\tnoun\t포근하고 온화하게 느껴지는 빛의 인상
윤기\tnoun\t표면에서 반들거리며 드러나는 빛
광택\tnoun\t표면이 빛을 반사해 반짝이는 성질
질감\tnoun\t표면을 만지거나 보며 느끼는 성질
결감\tnoun\t재료의 결이 손끝에 전하는 느낌
공기\tnoun\t주변을 채우며 몸에 닿는 기체
미온수\tnoun\t뜨겁지도 차갑지도 않은 물
한기\tnoun\t몸을 움츠리게 하는 찬 기운
`),
  parseGroup('C', 'scene-expansion', `
가로수\tnoun\t길가에 줄지어 심은 나무
갈대밭\tnoun\t갈대가 무리 지어 자라는 곳
고원\tnoun\t주변보다 높고 평평하게 펼쳐진 땅
구릉\tnoun\t높지 않은 산이나 언덕이 이어진 지형
늪\tnoun\t물이 고여 질척한 땅
늪지\tnoun\t늪이 넓게 형성된 습한 지역
마루금\tnoun\t산등성이를 따라 이어지는 선
다랑논\tnoun\t산비탈을 계단처럼 나눈 논
대숲\tnoun\t대나무가 빽빽하게 자라는 숲
도랑\tnoun\t물이 흐르도록 길게 파 놓은 작은 수로
둑\tnoun\t물이나 흙이 넘치지 않도록 쌓은 언덕
둑길\tnoun\t둑 위로 난 길
뒷산\tnoun\t집이나 마을 뒤에 가까이 있는 산
길머리\tnoun\t길이 시작되거나 다른 길로 갈라지는 첫머리
들풀\tnoun\t들에서 저절로 자라는 풀
먼바다\tnoun\t육지에서 멀리 떨어진 바다
모래언덕\tnoun\t바람에 모래가 쌓여 생긴 언덕
바위\tnoun\t크고 단단한 돌덩이
바위틈\tnoun\t바위와 바위 사이의 좁은 틈
백사장\tnoun\t흰 모래가 펼쳐진 바닷가
벼랑\tnoun\t깎아지른 듯 가파른 낭떠러지
볕\tnoun\t햇빛이 내리쬐는 기운
사구\tnoun\t바람에 모래가 쌓여 생긴 지형
산골\tnoun\t산으로 둘러싸인 외진 마을이나 지역
산골짜기\tnoun\t산과 산 사이로 깊게 패인 곳
산길\tnoun\t산을 오르내리며 이어지는 길
산비탈\tnoun\t산의 기울어진 면
산촌\tnoun\t산속에 자리 잡은 마을
샘\tnoun\t땅속에서 물이 솟아나는 곳
샘터\tnoun\t샘물이 솟는 자리와 그 주변
석양\tnoun\t해가 질 때의 붉은 햇빛
섬\tnoun\t물에 둘러싸인 땅
섬마을\tnoun\t섬에 자리한 마을
소나무숲\tnoun\t소나무가 모여 자라는 숲
수풀\tnoun\t나무와 풀이 우거진 곳
습지\tnoun\t물이 많아 축축한 땅
시골\tnoun\t도시에서 떨어진 농촌 지역
신작로\tnoun\t새로 닦은 넓은 길
아랫목\tnoun\t방에서 아궁이에 가까운 따뜻한 자리
앞마당\tnoun\t집 앞에 펼쳐진 마당
언덕\tnoun\t주변보다 조금 높게 솟은 땅
여울목\tnoun\t여울이 흐르는 물목
외딴곳\tnoun\t사람이 드물고 홀로 떨어진 곳
외딴섬\tnoun\t멀리 떨어져 홀로 있는 섬
울타리\tnoun\t공간의 경계를 둘러 세운 구조물
원두막\tnoun\t밭이나 들에 세운 작은 쉼터
잔디밭\tnoun\t잔디가 깔린 넓은 땅
장터\tnoun\t사람과 물건이 모여 거래하는 곳
저수지\tnoun\t물을 모아 두는 큰 못
전봇대\tnoun\t전선을 지탱하는 기둥
정원\tnoun\t나무와 꽃을 가꾸어 둔 뜰
지평선\tnoun\t땅과 하늘이 맞닿아 보이는 선
찻길\tnoun\t차가 다니도록 닦인 길
철길\tnoun\t기차가 다니는 선로
초승달\tnoun\t초승처럼 가늘게 보이는 달
초입\tnoun\t어떤 곳이나 일의 처음 들어가는 부분
촌락\tnoun\t사람들이 모여 사는 작은 마을
큰길\tnoun\t넓고 주요한 길
평야\tnoun\t넓고 평평하게 펼쳐진 들
하늘\tnoun\t땅 위로 펼쳐진 넓은 공간
하늘빛\tnoun\t하늘을 닮은 푸른 빛
해안\tnoun\t육지와 바다가 맞닿은 곳
해변\tnoun\t바다와 맞닿은 모래나 땅
햇볕\tnoun\t햇빛이 내리쬐는 따뜻한 기운
호숫가\tnoun\t호수와 맞닿은 가장자리
호수\tnoun\t육지에 둘러싸인 넓은 물
홍수\tnoun\t물이 크게 불어나 땅을 덮는 일
황혼\tnoun\t해가 지고 어둠이 오기 전의 시간
후미진곳\tnoun\t눈에 잘 띄지 않고 깊숙한 곳
휴게소\tnoun\t잠시 쉬어 갈 수 있도록 마련한 곳
가로등\tnoun\t길을 밝히는 등불
골목어귀\tnoun\t골목으로 들어서는 입구
구름층\tnoun\t하늘에 층처럼 모여 있는 구름
굴뚝\tnoun\t연기나 가스를 내보내는 통로
논길\tnoun\t논 사이로 이어진 좁은 길
논둑\tnoun\t논과 논 사이를 가르는 둑
마을어귀\tnoun\t마을로 들어서는 첫자리
물굽이\tnoun\t물이 굽어 흐르는 자리
배수로\tnoun\t고인 물을 흘려보내는 수로
사잇길\tnoun\t두 곳 사이로 난 작은 길
`),
  parseGroup('A', 'action-direction', `
가누다\tverb\t몸이나 마음을 바로 세우고 다스리다
가라앉히다\tverb\t들뜬 감정이나 움직임을 잦아들게 하다
차단하다\tverb\t길이나 흐름을 막아 지나가지 못하게 하다
갈아타다\tverb\t타고 있던 것을 다른 것으로 바꾸어 타다
감돌다\tverb\t주변을 맴돌며 흐르거나 떠돌다
감추다\tverb\t보이지 않게 숨기거나 드러내지 않다
거머쥐다\tverb\t손에 단단히 움켜잡다
걸터앉다\tverb\t엉덩이를 걸치듯 앉다
겨누다\tverb\t목표를 향해 방향을 맞추다
곁눈질하다\tverb\t고개를 돌리지 않고 곁으로 슬쩍 보다
구부리다\tverb\t곧은 것을 굽은 모양으로 만들다
굴리다\tverb\t둥근 것이 구르도록 움직이다
굽히다\tverb\t몸이나 물체를 휘어지게 하다
끌다\tverb\t물체를 자기 쪽으로 잡아당기며 움직이다
나누다\tverb\t하나를 여럿으로 가르거나 함께 가지다
낚다\tverb\t걸어 당겨서 잡아채다
내던지다\tverb\t아무렇게나 힘껏 던지다
내리다\tverb\t위에서 아래로 옮기거나 내려오다
넓히다\tverb\t범위나 폭을 더 크게 만들다
넘나들다\tverb\t경계나 여러 곳을 오가다
넘치다\tverb\t가득 차서 밖으로 흐르다
놓치다\tverb\t잡거나 따라갈 기회를 잃다
다독이다\tverb\t살살 두드리거나 마음을 달래다
다가오다\tverb\t어떤 대상이나 때가 가까이 오다
다그치다\tverb\t재촉하거나 몰아붙여 서두르게 하다
달래다\tverb\t슬픔이나 화를 가라앉히도록 어르다
닦다\tverb\t표면을 문질러 깨끗하게 하다
당겨오다\tverb\t자기 쪽으로 끌어 가까이 오게 하다
대치하다\tverb\t서로 맞서 마주 서다
던지다\tverb\t손에 든 것을 공중으로 내보내다
돌려세우다\tverb\t몸이나 방향을 다른 쪽으로 돌리다
들이받다\tverb\t세게 부딪치거나 맞서다
들이키다\tverb\t액체나 숨을 한꺼번에 마시다
따라붙다\tverb\t뒤에서 떨어지지 않고 쫓아가다
떠오르다\tverb\t가라앉은 것이 위로 올라오다
떼어내다\tverb\t붙어 있는 것을 떨어지게 하다
뚫다\tverb\t막힌 곳에 구멍을 내거나 지나가다
뛰놀다\tverb\t신나게 뛰며 놀다
마주보다\tverb\t서로 얼굴이나 방향을 향해 보다
맞서다\tverb\t상대와 물러서지 않고 대항하다
맞잡다\tverb\t서로의 손이나 물건을 함께 잡다
매달리다\tverb\t무언가에 붙어 떨어지지 않다
메우다\tverb\t빈 곳을 채워 없애다
몰아치다\tverb\t한꺼번에 세게 닥치거나 몰아붙이다
묻다\tverb\t모르는 것을 상대에게 말해 달라고 하다
밀려들다\tverb\t많은 것이 한꺼번에 들어오다
버티다\tverb\t어려움을 견디며 물러나지 않다
벗어나다\tverb\t구속이나 범위에서 빠져나오다
비비다\tverb\t두 면을 맞대고 문지르다
비켜나다\tverb\t부딪치지 않도록 옆으로 물러나다
빼앗다\tverb\t남의 것을 억지로 가져가다
뿜어내다\tverb\t기체나 액체를 세게 내보내다
사라져가다\tverb\t점점 보이지 않게 되어 가다
새다\tverb\t틈으로 액체나 기체가 빠져나가다
선회하다\tverb\t한곳을 중심으로 빙 돌다
숨죽이다\tverb\t숨소리를 낮추고 조용히 하다
스치다\tverb\t가볍게 닿거나 지나가다
시달리다\tverb\t괴로움이나 어려움을 계속 겪다
실어나르다\tverb\t물건을 옮겨 나르다
쏟다\tverb\t그릇의 내용물을 한꺼번에 흘리다
쏟아지다\tverb\t많은 것이 한꺼번에 떨어지거나 나오다
안기다\tverb\t품이나 팔 안으로 들어가다
앞세우다\tverb\t앞에 서게 하거나 먼저 내보내다
얹다\tverb\t위에 올려놓다
엎지르다\tverb\t담긴 것을 쏟아 버리다
옮기다\tverb\t자리나 장소를 바꾸어 이동시키다
움켜잡다\tverb\t손가락을 오므려 세게 잡다
일구다\tverb\t땅을 일구거나 일을 이루어 내다
잇다\tverb\t끊어진 것을 연결하다
자라나다\tverb\t생물이나 일이 점점 커지다
재촉하다\tverb\t빨리 하도록 다그치다
젖히다\tverb\t뒤로 넘어가게 하거나 열어젖히다
조르다\tverb\t원하는 것을 거듭 요구하다
주무르다\tverb\t손으로 누르고 문질러 다루다
지나다\tverb\t어떤 곳이나 시간을 거쳐 가다
지켜보다\tverb\t움직임을 계속 눈여겨보다
질주하다\tverb\t매우 빠르게 달리다
짚다\tverb\t손이나 도구로 가리키거나 누르다
치받다\tverb\t아래에서 위로 세게 밀어 올리다
치우다\tverb\t물건을 다른 곳으로 옮겨 정리하다
캐묻다\tverb\t자세한 내용을 거듭 물어보다
휘감다\tverb\t둘레에 감아 두르다
휘몰아치다\tverb\t바람이나 감정이 세차게 몰려오다
훑다\tverb\t빠짐없이 한 번 쭉 살펴보다
휘젓다\tverb\t이리저리 마구 저어 섞다
흩어지다\tverb\t한곳에 모인 것이 여러 방향으로 퍼지다
흘려보내다\tverb\t붙잡지 않고 지나가게 두다
힘주다\tverb\t힘을 들여 세게 하다
굴절하다\tverb\t곧게 가던 방향이 꺾여 나아가다
마주치다\tverb\t서로 만나거나 부딪치다
맞이하다\tverb\t오는 사람이나 일을 받아들이다
부딪치다\tverb\t서로 세게 닿거나 맞서다
비집고들어가다\tverb\t좁은 틈을 억지로 헤치며 들어가다
삼키다\tverb\t음식이나 말을 목으로 넘기다
움찔하다\tverb\t놀라거나 아파서 몸을 순간적으로 움직이다
깜빡이다\tverb\t눈을 잠깐 감았다 뜨거나 빛이 켜졌다 꺼지다
끄덕이다\tverb\t고개를 위아래로 움직여 뜻을 나타내다
숨다\tverb\t보이지 않는 곳에 몸을 감추다
솟아오르다\tverb\t아래에서 위로 힘차게 올라오다
잠기다\tverb\t물이나 액체 속에 들어가 가라앉다
`),
  parseGroup('O', 'direct-boundary', `
가위\tnoun\t종이나 천을 자르는 도구
가죽\tnoun\t동물의 몸에서 벗겨 내어 다듬은 껍질
간판\tnoun\t가게나 기관의 이름을 내건 표지
갑판\tnoun\t배 위에 넓게 마련된 바닥
갓\tnoun\t머리에 쓰는 둥근 테가 있는 모자
갯벌\tnoun\t바닷물이 빠져 드러나는 진흙 땅
건반\tnoun\t악기에서 손가락으로 누르는 판
경첩\tnoun\t문이나 뚜껑을 여닫게 하는 쇠붙이
고무줄\tnoun\t고무로 만들어 늘어나는 줄
곡괭이\tnoun\t단단한 땅을 파는 농기구
골무\tnoun\t바느질할 때 손가락을 보호하는 도구
공책\tnoun\t글이나 내용을 적는 책
괭이\tnoun\t땅을 파고 고르는 농기구
구두\tnoun\t가죽 등으로 만든 서양식 신발
국자\tnoun\t국이나 물을 뜨는 자루 달린 도구
기둥\tnoun\t건물이나 구조물을 받치는 세로대
나침반\tnoun\t방향을 가리키는 기구
납작돌\tnoun\t넓고 평평하게 생긴 돌
낫\tnoun\t풀이나 곡식을 베는 농기구
냄비\tnoun\t음식을 끓이거나 볶는 그릇
노트\tnoun\t메모나 공부 내용을 적는 공책
도르래\tnoun\t줄을 걸어 물건을 들어 올리는 바퀴
돋보기\tnoun\t작은 것을 크게 보이게 하는 도구
등받이\tnoun\t등을 기대도록 만든 부분
라디오\tnoun\t전파로 소리를 듣는 기기
망치\tnoun\t못을 박거나 물건을 두드리는 도구
매듭\tnoun\t끈이나 줄을 묶어 만든 마디
멍석\tnoun\t짚으로 엮어 만든 넓은 깔개
모자\tnoun\t머리에 쓰는 물건
목도리\tnoun\t목에 두르는 긴 천
무명천\tnoun\t무명실로 짠 천
물동이\tnoun\t물을 길어 나르는 큰 그릇
바구니\tnoun\t물건을 담아 나르는 용기
박스\tnoun\t물건을 담는 네모난 상자
방석\tnoun\t바닥이나 의자에 까는 작은 깔개
배낭\tnoun\t등에 메고 다니는 가방
벽돌\tnoun\t벽을 쌓는 데 쓰는 네모난 재료
보따리\tnoun\t물건을 보자기에 싸서 묶은 것
손전등\tnoun\t손에 들고 어두운 곳을 비추는 등
수첩\tnoun\t간단한 내용을 적어 두는 작은 공책
스웨터\tnoun\t털실로 짠 따뜻한 상의
신호등\tnoun\t빛으로 진행과 정지를 알리는 장치
액자\tnoun\t그림이나 사진을 끼워 두는 틀
양초\tnoun\t심지에 불을 붙여 밝히는 초
연장\tnoun\t일을 하는 데 쓰는 도구
옷걸이\tnoun\t옷을 걸어 두는 기구
우체통\tnoun\t편지를 넣어 보내는 통
유리창\tnoun\t유리로 만든 창문
이끼\tnoun\t습한 곳에 돋는 작은 식물
자\tnoun\t길이나 크기를 재는 도구
자루\tnoun\t물건을 담거나 손잡이로 쓰는 긴 부분
장갑\tnoun\t손을 보호하거나 덮는 물건
재봉틀\tnoun\t실로 천을 꿰매는 기계
전등\tnoun\t전기로 빛을 내는 등
종\tnoun\t속을 치면 소리가 나는 금속 기구
주걱\tnoun\t밥이나 음식을 뜨고 섞는 도구
지팡이\tnoun\t걸을 때 몸을 지탱하는 막대
찻잔\tnoun\t차를 담아 마시는 작은 잔
철사\tnoun\t가늘고 긴 금속 줄
초\tnoun\t불을 켜는 데 쓰는 심지와 왁스
침대\tnoun\t누워서 자거나 쉬는 가구
칼날\tnoun\t칼에서 실제로 베는 날카로운 부분
톱\tnoun\t톱니로 나무나 재료를 자르는 도구
풍경\tnoun\t바람에 흔들려 소리 나는 장식물
갈퀴\tnoun\t흙이나 낙엽을 긁어모으는 농기구
화분\tnoun\t식물을 심어 기르는 그릇
흙\tnoun\t땅을 이루는 부드러운 물질
흙먼지\tnoun\t흙이 가루처럼 날리는 먼지
손잡이\tnoun\t손으로 잡도록 달린 부분
책더미\tnoun\t책이 여러 권 쌓인 무더기
`),
  parseGroup('X', 'direct-boundary', `
가치\tnoun\t대상이 지니는 중요함이나 쓸모
가능성\tnoun\t앞으로 이루어질 수 있는 정도
갈등\tnoun\t서로 다른 마음이나 입장이 부딪치는 상태
감각\tnoun\t몸이나 마음으로 느끼고 알아차리는 능력
감정\tnoun\t대상을 향해 일어나는 마음의 반응
개성\tnoun\t다른 사람과 구별되는 자기만의 성질
결심\tnoun\t어떤 일을 하기로 마음을 굳히는 일
결핍\tnoun\t필요한 것이 모자라거나 없는 상태
공감\tnoun\t남의 마음이나 처지를 함께 느끼는 일
과정\tnoun\t어떤 일이 진행되어 가는 단계
관계\tnoun\t사람이나 대상 사이의 이어진 상태
기회\tnoun\t어떤 일을 할 수 있는 때나 조건
내면\tnoun\t사람의 마음속 깊은 부분
논리\tnoun\t생각을 이치에 맞게 이어 가는 방식
노력\tnoun\t목적을 이루려고 힘을 쓰는 일
단서\tnoun\t문제나 사건을 풀 수 있게 돕는 실마리
대목\tnoun\t글이나 일에서 특별히 두드러지는 부분
대조\tnoun\t서로 다른 점을 나란히 드러내는 일
맥락\tnoun\t말이나 일이 놓인 앞뒤의 흐름
명분\tnoun\t행동을 정당하게 보이게 하는 이유
목표\tnoun\t이루려고 정한 대상이나 지점
문맥\tnoun\t문장 앞뒤가 이어져 만드는 뜻의 흐름
방법\tnoun\t목적을 이루기 위해 쓰는 방식
방향\tnoun\t나아가거나 향하는 쪽
변주\tnoun\t기본 모양을 바꾸어 새롭게 풀어내는 방식
본질\tnoun\t대상을 그 대상답게 하는 근본 성질
사연\tnoun\t일이나 사람에게 얽힌 이야기
상황\tnoun\t일이 벌어진 때의 형편
성찰\tnoun\t자신의 생각과 행동을 깊이 돌아보는 일
소망\tnoun\t이루어지기를 바라는 마음
수단\tnoun\t목적에 이르기 위해 사용하는 방법이나 도구
습관\tnoun\t오래 반복하여 몸에 밴 행동 방식
시도\tnoun\t어떤 일을 처음으로 시험해 보는 일
신념\tnoun\t굳게 믿고 따르는 생각
실마리\tnoun\t문제를 풀거나 일을 시작하게 하는 단서
안팎\tnoun\t안쪽과 바깥쪽 또는 그 양쪽
여백\tnoun\t비어 있어 남겨 둔 공간
연속\tnoun\t끊이지 않고 이어지는 상태
영감\tnoun\t창작이나 생각을 떠오르게 하는 자극
원칙\tnoun\t행동과 판단의 기준이 되는 기본 규칙
의미\tnoun\t말이나 일이 나타내는 뜻
인상\tnoun\t대상을 보고 마음에 남는 느낌
장면\tnoun\t어떤 일이 벌어지는 한 부분의 모습
전환\tnoun\t상태나 방향을 다른 것으로 바꾸는 일
절차\tnoun\t일을 해 나가는 순서와 방법
조화\tnoun\t서로 어울려 균형을 이루는 상태
주제\tnoun\t글이나 말에서 중심이 되는 생각
질문\tnoun\t알고 싶은 것을 묻는 말
질서\tnoun\t부분들이 일정한 규칙에 따라 놓인 상태
차이\tnoun\t서로 같지 않고 벌어진 정도
눈치를 보다\texpression\t상대의 기분이나 뜻을 살피며 행동하다
발을 맞추다\texpression\t서로의 속도나 행동을 맞추다
귀를 세우다\texpression\t작은 소리에도 주의를 기울여 듣다
마음을 모으다\texpression\t여러 사람의 뜻이나 힘을 한데 모으다
마음을 다독이다\texpression\t불안하거나 상한 마음을 달래다
등을 기대다\texpression\t등을 다른 곳에 대고 몸을 의지하다
손을 잡다\texpression\t손을 맞잡거나 서로 협력하다
숨을 낮추다\texpression\t호흡과 기척을 작게 하여 조용해지다
입을 열다\texpression\t말을 시작하거나 비밀을 털어놓다
발걸음을 멈추다\texpression\t걷던 동작을 그치고 서다
`),
];

export const M5_11_CATALOG = Object.freeze(groups.flat());

const seenLemmas = new Set();
for (const entry of M5_11_CATALOG) {
  if (seenLemmas.has(entry.lemma)) {
    throw new Error(`duplicate M5-11 catalog lemma: ${entry.lemma}`);
  }
  seenLemmas.add(entry.lemma);
}

if (M5_11_CATALOG.length !== 550) {
  throw new Error(`M5-11 catalog must contain exactly 550 rows; got ${M5_11_CATALOG.length}`);
}
