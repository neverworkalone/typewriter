# Issue #225 sense-boundary audit

Parent: Issue #218. Source canonical revision: `3e07c1b224cc7f7324f044b807cef9e17d321c2c`.

## Inventory

| Measure | Result |
| --- | ---: |
| Multi-sense records reviewed | 249 |
| Senses in those records | 511 |
| Canonical senses | 5356 |
| Retain split with authored frame and route contrast | 42 |
| Merge over-split senses | 0 |
| Hold unresolved boundaries | 207 |

## Decision rule

Retain a split only when concrete frame evidence and a separately authored next-route contrast both distinguish every sense pair. Route evidence records an expected relation family/direction and a target POS or semantic class; an existing relation tuple is not required. Current tuples are corroborating observations only: matching routes do not establish equivalence, and missing routes do not justify a merge. Hold the current split whenever writer-facing evidence is incomplete.

## Retained splits

| ID | Lemma | Writer-facing frames | Authored next routes |
| --- | --- | --- | --- |
| w044 | 거칠다 | w044-s1: A touched surface feels uneven and coarse.<br>w044-s2: A person's speech or manner is forceful and unpolished. | w044-s1: sensory → physical surface texture<br>w044-s2: mood → speech or interpersonal manner |
| w045 | 부드럽다 | w045-s1: A touched surface feels smooth rather than coarse.<br>w045-s2: A person's manner is gentle and puts another person at ease. | w045-s1: sensory → physical surface texture<br>w045-s2: mood → interpersonal manner |
| w046 | 날카로움 | w046-s1: An edge or point is physically sharp and can cut.<br>w046-s2: A sense or response is sensitive and quick. | w046-s1: sensory → cutting edge or point<br>w046-s2: action → sensitivity or quick response |
| w047 | 둔함 | w047-s1: An edge or point is physically blunt and does not cut well.<br>w047-s2: A sense or response is slow and not very sensitive. | w047-s1: sensory → physical edge or cutting ability<br>w047-s2: mood → perception or response speed |
| w048 | 가벼움 | w048-s1: An object's physical weight is low.<br>w048-s2: The burden of a task or feeling is small. | w048-s1: sensory → object mass and weight<br>w048-s2: association → task or emotional burden |
| w049 | 무거움 | w049-s1: An object's physical weight is high.<br>w049-s2: A task or feeling places a substantial burden on someone. | w049-s1: sensory → object mass and weight<br>w049-s2: association → task or emotional burden |
| w052 | 깊음 | w052-s1: A physical space has a large distance to its bottom or end.<br>w052-s2: Thought or emotion continues broadly and deeply over time. | w052-s1: scene → physical space and distance<br>w052-s2: mood → reflection or emotional depth |
| w053 | 얕음 | w053-s1: A physical space has a small distance to its bottom or end.<br>w053-s2: Thought or emotion stays superficial rather than examining a matter. | w053-s1: scene → physical space and distance<br>w053-s2: association → reflection or judgement |
| w066 | 빛 | w066-s1: Light makes a dark scene or an object visible.<br>w066-s2: A surface or color presents a particular brightness and hue. | w066-s1: sensory → illumination and visibility<br>w066-s2: sensory → surface color and hue |
| w068 | 그림자 | w068-s1: An object blocks light and casts a dark shape behind or below it.<br>w068-s2: An influence or trace follows a person or event over time. | w068-s1: sensory → visible light and shape<br>w068-s2: association → lasting influence or trace |
| w070 | 빛바램 | w070-s1: A color or light weakens as time passes.<br>w070-s2: The clarity of a memory or emotion weakens over time. | w070-s1: sensory → color or light fading<br>w070-s2: mood → memory or emotional clarity |
| w075 | 온도 | w075-s1: A physical object or space has a measurable hot or cold state.<br>w075-s2: A person or relationship gives off a warm or cold atmosphere. | w075-s1: sensory → physical heat or cold<br>w075-s2: mood → relational warmth or coldness |
| w076 | 열기 | w076-s1: Air or an object gives off physical heat.<br>w076-s2: A group becomes absorbed and collectively excited. | w076-s1: sensory → physical heat<br>w076-s2: mood → collective excitement |
| w081 | 서늘함 | w081-s1: Air or a physical scene feels slightly cold.<br>w081-s2: A tone or atmosphere feels cold and eerie. | w081-s1: sensory → physical coldness<br>w081-s2: mood → eerie atmosphere or tone |
| w085 | 메마름 | w085-s1: A physical surface or state has lost moisture or vitality and is dry.<br>w085-s2: An emotion or relationship lacks warmth and liveliness. | w085-s1: sensory → dryness and texture<br>w085-s2: mood → emotional or relational distance |
| w133 | 눈 | w133-s1: A body organ receives light so a person can see objects.<br>w133-s2: White ice grains fall from the sky into a weather scene. | w133-s1: action → seeing and looking<br>w133-s2: scene → snowfall and landscape |
| w134 | 바람 | w134-s1: Moving air touches skin or moves objects in a scene.<br>w134-s2: A person hopes for an outcome to come true. | w134-s1: sensory → moving air and bodily sensation<br>w134-s2: mood → wish or desired outcome |
| w185 | 돌아보다 | w185-s1: A person turns the body or gaze toward a place behind or already passed.<br>w185-s2: A person considers past events or other people. | w185-s1: action → turning and looking<br>w185-s2: association → reflection on events or people |
| w186 | 떠나다 | w186-s1: A person leaves a place or another person's side and goes elsewhere.<br>w186-s2: A person reaches the end of life. | w186-s1: scene → departure and places<br>w186-s2: mood → death, grief, or loss |
| w200 | 말하다 | w200-s1: A speaker expresses a thought or feeling as audible speech.<br>w200-s2: A speaker informs another person of content or a fact. | w200-s1: sensory → speech and voice<br>w200-s2: association → news or conveyed information |
| w237 | 쓰다 | w237-s1: A person makes and records written language.<br>w237-s2: A person operates a tool or object for a purpose.<br>w237-s3: A person puts on or wears clothing or an accessory.<br>w237-s4: A taste is perceived by the tongue as unpleasant and sharp. | w237-s1: direct → writing and recorded text<br>w237-s2: direct → tools and practical use<br>w237-s3: direct → clothing worn on the body<br>w237-s4: association → bitter flavor or medicine |
| w248 | 얼굴 | w248-s1: A physical part at the front of the head contains the eyes, nose, and mouth.<br>w248-s2: A person's expression or outward appearance is visible to others. | w248-s1: sensory → facial features and appearance<br>w248-s2: action → expression and gesture |
| w250 | 손 | w250-s1: A body part at the end of an arm grasps or moves objects.<br>w250-s2: A person or force contributes help or labor. | w250-s1: action → grasping and physical movement<br>w250-s2: association → assistance or labor |
| w251 | 발 | w251-s1: A body part at the end of a leg supports the body and enables walking.<br>w251-s2: A step or trace marks movement from one place to another. | w251-s1: action → walking and bodily movement<br>w251-s2: scene → footsteps and paths |
| w252 | 머리 | w252-s1: The physical part above the neck contains the brain and face.<br>w252-s2: A person thinks and judges with a mental capacity. | w252-s1: sensory → head and facial anatomy<br>w252-s2: association → thought or judgement |
| w253 | 어깨 | w253-s1: A physical part joins the arm and torso.<br>w253-s2: A person takes a position of responsibility or burden. | w253-s1: sensory → shoulder and bodily sensation<br>w253-s2: association → responsibility or burden |
| w271 | 마음 | w271-s1: A person's inner life feels thoughts and emotions.<br>w271-s2: A person forms an intention or willingness to act. | w271-s1: mood → thoughts and emotions<br>w271-s2: action → intention or willingness to act |
| w272 | 생각 | w272-s1: A person mentally considers or recalls a subject or event.<br>w272-s2: A person settles on an opinion or judgment about a matter. | w272-s1: action → considering or recalling<br>w272-s2: association → opinion, reasons, or judgement |
| w273 | 말 | w273-s1: A word or sentence expresses a person's thought or intention.<br>w273-s2: A person speaks a story or utterance aloud. | w273-s1: association → written or expressed language<br>w273-s2: sensory → spoken utterance and voice |
| w280 | 소식 | w280-s1: New information arrives about a person or event.<br>w280-s2: A message communicates someone's well-being or recent circumstances. | w280-s1: association → news or new information<br>w280-s2: mood → personal wellbeing or longing |
| w291 | 발이 묶이다 | w291-s1: A person's feet cannot move, so the person cannot leave a place.<br>w291-s2: Circumstances prevent a person from acting or moving freely. | w291-s1: near → physical immobility<br>w291-s2: mood → constraint and helplessness |
| w308 | 애증 | w308-s1: One target receives love and dislike at the same time.<br>w308-s2: A person wants to leave a loved relationship or target but cannot let go. | w308-s1: mood → simultaneous love and dislike<br>w308-s2: mood → attachment and difficulty separating |
| w315 | 느슨하다 | w315-s1: A physical object or fastening is loose rather than taut.<br>w315-s2: A rule or a state of tension is lenient and leaves room. | w315-s1: sensory → loose objects or fastenings<br>w315-s2: association → lenient rules or reduced tension |
| w325 | 아릿하다 | w325-s1: A localized part of the body feels slightly numb and painful.<br>w325-s2: An emotion is touched and the heart aches. | w325-s1: sensory → localized bodily pain<br>w325-s2: mood → emotional ache or longing |
| w326 | 시큰하다 | w326-s1: Teeth or joints ache with a cold or throbbing bodily sensation.<br>w326-s2: The heart aches emotionally and rises into a sudden feeling. | w326-s1: sensory → teeth or joint pain<br>w326-s2: mood → sadness or emotional ache |
| w328 | 여명 | w328-s1: Light grows in the darkness before sunrise.<br>w328-s2: A sign appears that an event or era is about to begin. | w328-s1: sensory → dawn light<br>w328-s2: association → signs of a new beginning |
| w336 | 흘러가다 | w336-s1: Water or another liquid moves continuously in one direction.<br>w336-s2: Time or a state passes without stopping. | w336-s1: scene → liquid and movement<br>w336-s2: scene → time and seasonal change |
| w337 | 스며들다 | w337-s1: Liquid or light passes through a gap into an interior.<br>w337-s2: An emotion or thought gradually spreads into the mind. | w337-s1: sensory → liquid, light, or moisture<br>w337-s2: mood → thoughts or feelings spreading |
| w339 | 사라지다 | w339-s1: Something visible or present can no longer be seen or found.<br>w339-s2: A memory or emotion gradually ceases to remain. | w339-s1: near → visual absence or faintness<br>w339-s2: near → memory or emotional loss |
| w340 | 번지다 | w340-s1: Liquid or color spreads outward over a surface.<br>w340-s2: An emotion or expression spreads outward and becomes visible to others. | w340-s1: sensory → liquid, color, or surface<br>w340-s2: mood → emotion or expression |
| w342 | 더듬다 | w342-s1: A hand or sense searches by feeling along a physical space.<br>w342-s2: A speaker struggles to retrieve a word or memory. | w342-s1: action → tactile searching<br>w342-s2: association → word or memory retrieval |
| w349 | 얼룩 | w349-s1: Water or dirt leaves a visible mark on a surface.<br>w349-s2: A memory or reputation retains a lasting stain. | w349-s1: sensory → color and surface marks<br>w349-s2: association → memory or reputation traces |

## Merge

No over-split is confirmed by positive semantic evidence in this audit. Matching current relation paths alone do not justify merging senses.

## Holds

207 current splits remain unchanged. 205 lack an authored frame contrast, and 207 lack independently authored next-route evidence. 2 have recorded frame distinctions but still need that route evidence. Existing relation paths remain in the machine inventory as corroborating observations only.

For `w321 미지근하다`, the physical-temperature and figurative-response frames differ, but both current tuples point to `near → r042-s1`. That shared target is not positive evidence that the writer-facing boundary is equivalent, so both senses remain pending independently authored route evidence.

For `w5356 기억`, the glosses distinguish the mental act of retaining past events from remembered content that returns to mind. Preserve both senses pending concrete evidence about the writer’s next relation direction or target POS/semantic class.

Held record IDs:

w032, w054, w097, w098, w1006, w1008, w1009, w1018, w1046, w1068, w1069, w1070, w1072, w1073, w1078, w108, w1080, w1082, w1084, w1085, w1088, w1089, w109, w1090, w1091, w1092, w1096, w1097, w1098, w1100, w1101, w1103, w1104, w1105, w1108, w1111, w1119, w1120, w1123, w1124, w1125, w1129, w1131, w1133, w1136, w1138, w1143, w1148, w1149, w1150, w1152, w1153, w1154, w1158, w117, w1176, w1204, w1222, w1224, w1225, w1232, w1237, w1239, w1247, w1255, w1256, w1258, w1260, w1270, w1271, w1272, w1273, w1274, w1275, w1276, w1277, w1278, w140, w191, w194, w195, w201, w205, w207, w213, w220, w275, w284, w286, w293, w294, w298, w310, w316, w318, w321, w329, w338, w347, w361, w363, w364, w373, w405, w410, w420, w421, w456, w458, w459, w460, w462, w472, w481, w517, w518, w519, w520, w527, w528, w535, w5350, w5351, w5356, w536, w542, w546, w547, w548, w549, w552, w556, w558, w559, w560, w561, w562, w563, w565, w566, w567, w568, w569, w578, w588, w595, w598, w599, w603, w604, w606, w609, w617, w618, w619, w620, w621, w622, w628, w719, w734, w744, w746, w750, w753, w785, w791, w802, w810, w811, w813, w819, w825, w826, w838, w843, w850, w853, w861, w863, w864, w867, w870, w873, w874, w876, w878, w884, w890, w894, w903, w910, w913, w914, w916, w919, w930, w932, w936, w938, w952, w965, w967, w968, w970, w983, w992

The complete sense text, POS, current relation-path observations, authored frame reviews, and per-record rationale are in [the machine inventory](issue-225-sense-boundary-audit.json).
