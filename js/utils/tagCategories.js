/**
 * 🏷️ 标签大分类体系（v2.2.0）
 * 把系统/全局标签按「大分类」归组，让标签云按分类展示、更好找。
 * 18 个大分类：人物关系 / 身份职业 / 性格特质 / 角色设定 / 外貌身材 / 情境场所 /
 *   时代背景 / 力量体系 / 题材世界观 / 种族物种 / 情感基调 / 故事剧情 /
 *   内容分级 / 性玩法 / 玩法类型 / 卡片功能 / 文风语言 / 其他
 *
 * 五级分类策略：
 *   ⓪ 用户手动归属优先（customTagAssignments，覆盖一切自动结果）
 *   ① 精确特例（单字词防子串误伤：ai→卡片、jk→学生、cot→提示链…）
 *   ② 斜杠复合词首段（「主仆/女仆」→「主仆」→ 人物关系）
 *   ③ 关键词规则（基于库内实际标签统计调优；结果记忆化缓存 O(1)）
 *   ④ 向量语义兜底（规则未命中的标签 → 本地向量模型与各分类描述余弦匹配）
 *   ⑤ 「其他」兜底
 * 标签格式兼容 'Male (男性)' / 'Fantasy (奇幻/魔法)' / '魔法' / '病娇/黑化' 等。
 */
import { ref } from 'vue';

export const TAG_CATEGORIES = [
    { key: 'relation',   name: '人物关系', icon: '💞' },
    { key: 'occupation', name: '身份职业', icon: '💼' },
    { key: 'personality', name: '性格特质', icon: '🎯' },
    { key: 'character',  name: '角色设定', icon: '🎭' },
    { key: 'appearance', name: '外貌身材', icon: '💃' },
    { key: 'setting',    name: '情境场所', icon: '🏙️' },
    { key: 'era',        name: '时代背景', icon: '⏳' },
    { key: 'power',      name: '力量体系', icon: '✨' },
    { key: 'worldview',  name: '题材世界观', icon: '🌍' },
    { key: 'species',    name: '种族物种', icon: '🧝' },
    { key: 'mood',       name: '情感基调', icon: '💔' },
    { key: 'plot',       name: '故事剧情', icon: '📖' },
    { key: 'rating',     name: '内容分级', icon: '🈲' },
    { key: 'sexual',     name: '性玩法', icon: '🔞' },
    { key: 'gameplay',   name: '玩法类型', icon: '🎮' },
    { key: 'cardtype',   name: '卡片功能', icon: '🛠️' },
    { key: 'style',      name: '文风语言', icon: '✍️' },
    { key: 'other',      name: '其他', icon: '🏷️' }
];

// 🧠 各分类语义描述（向量兜底：未知标签与这些描述做余弦相似度匹配）
const CATEGORY_DESCRIPTIONS = {
    relation: '这是一个关于人物关系的标签：恋人、夫妻、姐妹、母女、父子、青梅竹马、主仆、人妻、后宫、上司下属等角色之间的关系',
    occupation: '这是一个关于身份职业的标签：医生、护士、教师、学生、军人、特工、杀手、女仆、执事、公主、贵族、警官、律师等职业身份',
    personality: '这是一个关于性格特质的标签：病娇、傲娇、温柔、冷静、忠诚、黑化、毒舌、随性、外冷内热、讨好型人格等性格描写',
    character: '这是一个关于角色基础设定的标签：性别、男性、女性、扶她、反派、神明、神话生物、魔法少女等角色属性',
    appearance: '这是一个关于外貌身材的标签：发型发色、体型、身材特征、眼镜、巨乳、萝莉、御姐等外貌描写',
    setting: '这是一个关于情境场所的标签：校园、医院、职场、监狱、城市、太空等故事发生的场景地点环境',
    era: '这是一个关于时代背景的标签：古代、现代、历史、未来、末世废土、中世纪等时代背景设定',
    power: '这是一个关于力量体系的标签：魔法、修仙、仙侠、系统、异能、超能力、神秘学等超自然力量体系',
    worldview: '这是一个关于题材世界观的标签：奇幻、科幻、赛博朋克、武侠、克苏鲁、异世界、穿越重生等题材设定',
    species: '这是一个关于种族物种的标签：人类、精灵、恶魔、天使、吸血鬼、机器人、魔物娘、幽灵妖怪等生物种族',
    mood: '这是一个关于情感基调的标签：纯爱、温馨、胃疼、虐心、黑暗、治愈、恋爱浪漫等情感氛围',
    plot: '这是一个关于故事剧情的标签：剧情走向、冒险、战斗、恐怖悬疑、群像、堕落、搞笑等剧情内容',
    rating: '这是一个关于内容分级的标签：SFW全年龄、NSFW成人、限制级、搞颜色等分级标记',
    sexual: '这是一个关于性玩法的标签：性行为、性癖、调教、捆绑、露出等成人内容',
    gameplay: '这是一个关于玩法类型的标签：沙盒、生存、探索、养成、策略、角色扮演、高自由度等玩法机制',
    cardtype: '这是一个关于卡片功能的标签：工具卡、世界书、设定集、提示词、辅助创作等卡片用途类型',
    style: '这是一个关于文风语言的标签：文风、文风指南、古风、写作风格等语言文字风格',
    other: '这是一个关于其他杂项内容的标签'
};

// 关键词规则（顺序敏感：更具体的分类在前，避免宽泛词误吞）
const RULES = [
    {
        key: 'sexual',
        keywords: ['口交', '性交', '性爱', '中出', '内射', '捆绑', '露出', '调教', '足交', '乳交',
            '肛交', '轮奸', '强奸', '自慰', '玩具', '束缚', '受虐', '身体开发', '触手', '乱交',
            '重口味', '猎奇', '足控', '贞操', '性癖', '官能', 'xp大全', 'xp合集', '超m', '群交',
            '多p', '乱伦', '近亲', '公媳', '父女', '骨科', '洗脑', '催眠', '性奴', '肉便器',
            '绿帽', '绿主', '苦主', '雌堕', '男娘', '伪娘', '扶她', '双修', '采补', '人兽',
            '人妖', '性瘾', '性开放', '恋物', '恋尸', '痴女', '媚黑', '背德', '高潮', '颜射',
            '口爆', '后入', '母乳', '人体改造', '体液', '凌辱', '丸吞', '乳控', '献身',
            '性剥削', '射精', '性别转换', '变性', '囚禁', '性转', '恋母', '母狗', '母猪',
            '援交', '圆交', '圆椒', '圆角', '羞辱', '雌雄同体', '阴阳人', '逆睡奸', '打手枪',
            '女绿', '强制', '施虐', '暴露', '气味', '泡妞', '猎艳', '红奴', '裸露', 's/m',
            '非自愿', '变百', '交融', '性病', '性奴', '肉便器纹身',
            'abdl', 'beastiality', 'bestiality', 'blowjob', 'breeding',
            'bukkake', 'cock worship', 'cuckold', 'degradation', 'dubcon', 'dub-con', 'edging',
            'facesitting', 'femdom', 'footjob', 'footplay', 'freeuse', 'gangbang', 'guro',
            'hentai', 'humiliation', 'impregnation', 'incest', 'lactation', 'masochism',
            'masturbation', 'mindbreak', 'mind break', 'mind control', 'brainwashing',
            'necrophilia', 'netori', 'ntr', 'noncon', 'non-con', 'non-consensual', 'petplay',
            'public play', 'rape', 'reverse rape', 'shota', 'shotacon', 'sizeplay', 'size play',
            'size difference', 'spanking', 'squirting', 'tentacle', 'vore', 'voyeur', 'yaoi',
            'yuri', 'orgasm', 'sex', 'urine', 'pegging', 'snuff', 'ahegao', 'nympho', 'chastity',
            'penis', 'nipple', 'dick', 'cock', 'ntl', 'xp', '尿奴', '排泄', '脚奴', 'bdsm',
            'bondage', 'orgy', 'creampie', 'anal', 'oral', 'fellatio', 'cunnilingus',
            'public sex', 'exhibition', '淫', '色情', '偷窥', 'latex', 'fetish', 'sperm',
            'clit', 'feminization', 'deformation', 'cunny', 'fellatrix', 'ero', 'shrink',
            '诱惑', '调情', '荤话', '性欲旺盛', '汗味', '体味', '乳穴', '恋孕', '曹贼', '色气', '夺爱', '禁断', '项圈']
    },
    {
        key: 'rating',
        keywords: ['nsfw', 'sfw', '成人', '敏感', '限制级', '全年龄', '全龄', 'smut', '搞颜色',
            'r18', 'r-18', '18+', '18禁', '限制', '性向', 'explicit', 'erotic', 'porn',
            'nsfl', '高h', '重口', '色色', '情色', '双性恋', '戒色']
    },
    {
        key: 'appearance',
        keywords: ['巨乳', '贫乳', '爆乳', '萝莉', '御姐', '正太', '金发', '银发', '黑发', '白发',
            '粉发', '短发', '眼镜', '眼罩', '高挑', '娇小', '丰臀', '肥臀', '丰腴', '身材',
            '肌肉', '黑长直', '网袜', '失明', '盲人', '孕妇', '豹纹', '泪痣', '黑裙', '辣妹',
            '艳骚', '少女', '少年', '敏锐', '感官', '双马尾', '黑丝', '丝袜', '高跟', '情趣内衣',
            '美臀', '白虎', '幼女', '人偶', '轮椅', '假小子', '女装', '男装', '漂亮', '美丽',
            '处女', '时髦', '旗袍', '纹身', '黄毛', '孕期', 'big ass', 'big breast', 'big boobs',
            'big tits', 'big thighs', 'chubby', 'curvy', 'huge ass', 'huge breasts', 'huge butt',
            'massive ass', 'massive breasts', 'plump', 'thick thighs', 'thick', 'shortstack',
            'giantess', 'stockings', 'high heels', 'high-heels', 'pink hair', 'white hair',
            'red eyes', 'green skin', 'scar', 'sweat', 'wound', 'mature', 'teenager', 'teen',
            'young', 'woman', 'femboy', 'crossdresser', 'otokonoko', 'anorexic', 'pregnant',
            'pregnancy', 'disabled', 'amputee', 'hag', 'gilf', 'loli', 'lolita', 'busty',
            'flat chest', 'blonde', 'silver hair', 'glasses', 'tall', 'petite', 'muscular',
            'beauty', 'detailed body description', 'girly', 'goth', 'gothic', 'punk',
            'big boobies', 'body modification', 'physiology', 'thighs', 'breasts',
            'gyaru', 'long tongue', '美艳', '丰满', '肉感', '长发', '紧身衣', '正装', '职业装',
            '罩杯', '兽角', '身体改造', 'blind']
    },
    {
        key: 'gameplay',
        keywords: ['沙盒', '生存', '探险', '探索', '养成', '策略', '模拟', '角色扮演', '高自由度',
            '经营', '解谜', '开放世界', '求生', '大世界', 'sandbox', 'simulator',
            'open world', 'open-world', 'survival', 'exploration', 'roguelike', 'galgame', 'gal']
    },
    {
        key: 'cardtype',
        keywords: ['工具', '助手', '辅助', '设定', '设定集', '设定生成', '世界设定', '世界构建', '世界观构建',
            '世界观', '世界书', '提示词', '教程', '功能', '创作', '实用', '实用主义', '通用',
            '旁白', '互动', '精简', '正则', '优化', '知识库', '架构', '预设', 'tavernai',
            '虚拟', '自定义', '测试', '写卡', '角色卡制作', '角色模板', '剧本', '视角',
            '规则', '多人对话', '空白', '客服', '解答', '支持', '生成器', '状态栏', '定制',
            '叙事', '引擎', '手机', '论坛', '认证', '视频', '网络', '社交媒体', '任务驱动',
            '多玩法', '多轮', '群组', '叙述者', '沉浸式', '深度', '纯人物', 'token',
            'multiple greetings',
            'alternate greetings', 'image generating', 'preview', 'helpers', 'customizable',
            'discussion', 'pov', 'tavern', 'lorebook', 'worldbook', 'generator', 'prompt',
            'jailbreak', 'preset', 'template', 'expression', 'mvu', 'ejs', 'w++', 'storyteller',
            'chat', 'website', 'rpg', 'scenario', 'narrator', 'assistant', 'utility', '随机生成']
    },
    {
        key: 'style',
        keywords: ['文风', '古风', '写作', '风格', '语言', '辞藻', '文笔', '笔风', '哥特', '人称',
            '写实', '纪实', '刻画', '描写', '粗口', '艺术感', '渲染', '中文', '英文', '日语',
            '日文', '金庸', '骚话', '纯文字', 'plaintext', 'english', 'chinese', 'french',
            'japanese', 'writing', 'prose', 'narrative', '方言']
    },
    {
        key: 'occupation',
        keywords: ['医生', '护士', '教师', '老师', '学生', '侦探', '女仆', '执事', '公主', '贵族',
            '皇室', '军人', '特工', '士兵', '杀手', '警官', '律师', '商人', '秘书', '偶像',
            '艺人', '社长', '总裁', '画廊', '艺术家', '性工作', '战士', '女王', '大小姐',
            '高中生', '保洁员', '修女', '巫女', '女巫', '法师', '道士', '盗贼', '模特', '歌手',
            '舞者', '摄影', '销售', '中介', '教授', '讲师', '警花', '锦衣卫', '雇佣兵', '王子',
            '女帝', '校花', '班长', '按摩女', '福利姬', '网红', '主播', '老板', '师父', '师匠',
            '作家', '导演', '死灵法师', '中医', '初中生', '警察', '明星', '政客', '牧师', '神父',
            '科学家', '工程师', '程序员', '厨师', '服务员', '忍者', '武士', '剑客', '囚犯',
            '骑士', '名妓', '前端', '医疗', '司机', '潜行者', '花魁', '野蛮人',
            'doctor', 'teacher', 'professor', 'student', 'nurse',
            'nun', 'priest', 'witch', 'mage', 'knight', 'queen', 'king', 'prince', 'princess',
            'idol', 'vtuber', 'streamer', 'streaming', 'prostitute', 'whore', 'escort',
            'serial killer', 'killer', 'therapist', 'stylist', 'ceo', 'executive',
            'office lady', 'tutor', 'soldier', 'mercenary', 'pirate', 'thief', 'ninja',
            'samurai', 'monk', 'noble', 'royal family', 'squire', 'coser', 'maid',
            'butler', 'royalty', '画师', '美食家', '搜查官', '风俗娘', '妓女', '风尘女子',
            '私掠者', '勇者', '邪僧', '从良', '千金', '海盗', '大提琴', '私掠']
    },
    {
        key: 'relation',
        keywords: ['青梅竹马', '继亲', '主仆', '人妻', '熟女', '太太', '后宫', '修罗场',
            '恋人', '姐妹', '母女', '母子', '姐弟', '兄妹', '师生', '上司', '下属', '姐姐',
            '妹妹', '哥哥', '弟弟', '丈夫', '妻子', '儿子', '女儿', '父亲', '母亲', '岳父',
            '岳母', '主人', '婚姻', '女友', '百合', '乱伦', '重逢', '旧识', '父子', '兄控',
            '弟控', '姐控', '妹控', '闺蜜', '兄弟', '师徒', '室友', '邻居', '老婆', '金主',
            '男朋友', '女朋友', '爸爸', '妈妈', '已婚', '单亲妈妈', '前女友', '炮友', '青梅',
            '情妇', '情夫', '夫妻', '孤儿', '复杂关系', '秘密关系', '友情', 'brother',
            'sibling', 'daughter', 'mom', 'mommy', 'dad', 'father', 'family', 'husband',
            'neighbor', 'roommate', 'boyfriend', 'girlfriend', 'harem', 'reverse harem',
            'dommy mommy', 'dommy daughter', 'step daughter', 'step mother', 'big brother',
            'wife', 'master/slave', 'childhood friend', 'step-family', 'milf', 'oyakodon',
            'lover', 'sister', 'mother', '未亡人', '继女', '重组家庭', '家庭', '同居', '年下',
            '年下控', '橘里橘气']
    },
    {
        key: 'personality',
        keywords: ['病娇', '傲娇', '三无', '温柔', '冷静', '忠诚', '支配', '黑化', '毒舌', '讨好',
            '人格', '安全感', '外冷内热', '斯多葛', '随性', '现实主义', '实用主义', '懦弱',
            '勇敢', '善良', '腹黑', '天然呆', '元气', '优雅', '成熟', '知性', '细腻', '青涩',
            '傲慢', '强势', '耐心', '专业', '叛逆', '高冷', '顺从', '冷酷', '忠犬', '母性',
            '独占欲', '魅惑', '贤妻', '傻白甜', '反差', '单纯', '坚强', '开朗', '幽默', '活泼',
            '清冷', '害羞', '势利', '包容', '中二', '嘴硬', '要强', '恶劣', '自恋', '认知失调',
            '精神疾病', '忧郁', '闷骚', '下流', '低俗', '极度厌女', '疯', '变态', '占有欲',
            '控制欲', '依恋', '讨好', '随和', '活泼', '主导', '心理', '可爱', '阳光', '内向',
            '外向', '乐观', '悲观', '邪恶', '臣服', '服从', '拜金', '物质主义', '随心所欲',
            '强撑', '疯子', '细节控', '自我', '人性', '奉献', '校霸', '媚男', '溺爱',
            '唯我独尊', '矛盾', 'aggressive', 'confident',
            'crazy', 'cute', 'evil', 'funny', 'kind', 'rude', 'sad', 'serious', 'shy', 'silly',
            'stupid', 'sweet', 'cooperative', 'ditzy', 'innocent', 'oblivious', 'naughty',
            'horny', 'humorous', 'seductive', 'vulgar', 'masochistic', 'sadistic', 'domineering',
            'stutter', 'timid', 'gentle', 'cruel', 'emotional', 'emotionless', 'caring',
            'protective', 'playful', 'childish', 'immature', 'depressed', 'depression', 'brat',
            'bully', 'bipolar', 'airhead', 'clever', 'loyal', 'creepy', 'adaptable',
            'autistic', 'submission', 'dominance', 'bitchy', 'smug', 'savage', 'soft',
            'mental', 'dual personality', 'protect', 'immatur', 'yandere', 'tsundere',
            'kuudere', 'submissive', 'dominant', '虚伪', '慵懒', '俏皮', '撒娇', '理性', '工作狂',
            '天然', '无口', '冷淡', '严厉', '狂热', '宠溺', '百依百顺', '朴实', '屈辱', '羞耻感',
            '母爱', 'istj']
    },
    {
        key: 'era',
        keywords: ['古代', '现代', '近代', '历史', '未来', '末世', '废土', '中世纪', '维多利亚',
            '昭和', '帝国', '世纪', '末日', '乱世', '民国', '明代', '秦朝', '清朝', '80s',
            'modern', 'historical', 'post-apocalyptic', 'victorian', 'medieval', 'ancient',
            'contemporary', '年代文', '年代感', '大航海']
    },
    {
        key: 'power',
        keywords: ['魔法', '修仙', '仙侠', '系统', '神力', '退魔', '神秘', '异能', '超能力', '武术',
            '道法', '灵力', '斗气', '功法', '咒术', '魔法少女', 'powerful', 'magic',
            'superpower', 'powers', 'cultivation', 'system', '诅咒', '魔药', '结界', '阵法', '能力', '修真']
    },
    {
        key: 'species',
        keywords: ['精灵', '妖精', '恶魔', '天使', '吸血鬼', '魅魔', '兽人', '福瑞', '怪物', '异种',
            '仿生人', '人造人', '机娘', '亚人', '兽耳', '狼人', '猫娘', '幽灵', '妖怪', '机器人',
            '魔物娘', '人外', '龙', '狐', '非人', '人形', '鬼怪', '机甲', '人工智能', '猫妖',
            '九尾', '乌鸦', '仙子', '美人鱼', '人鱼', '僵尸', '改造人', '类人', '死神', 'anthro',
            'beast', 'cryptid', 'dragon', 'feral', 'scalie', 'elf', 'demon', 'angel', 'goblin',
            'slime', 'undead', 'zombie', 'ghost', 'robot', 'sexbot', 'living doll', 'alien',
            'medusa', 'mermaid', 'yokai', 'jiangshi', 'kitsune', 'neko', 'catgirl', 'cat boy',
            'catboy', 'fox girl', 'foxgirl', 'werewolf', 'vampire', 'succubus', 'god',
            'goddess', 'deity', 'monster girl', 'vampress', 'shipgirl', 'bear girl', 'moth',
            'animals', 'pets', 'cybernetic', 'giant', 'parasite', 'cat girl', 'incubus',
            'furry', 'monster', 'android', 'beastman', 'kemonomimi', 'human', '人类', '式神',
            '黑人', '麒麟', '半人半仙']
    },
    {
        key: 'character',
        keywords: ['男性', '女性', '扶她', '非二元', '多角色', '反派', '神明', '神话', '主角',
            '配角', '正派', '幸存者', '奴隶', '多女主', '过去', 'rich', 'slave', 'child',
            'children', 'dead', 'multiple girls', 'multiple personality', 'antagonist',
            'famous', 'character', '贵妇', '蛇蝎美人', '白月光', '路人', '女侠', '多人',
            '多女', '女神', '单人', '女多男少', 'futa',
            'male', 'female', 'non-binary', 'multiple characters', 'villain', 'npc', '魔王']
    },
    {
        key: 'worldview',
        keywords: ['奇幻', '科幻', '赛博朋克', '蒸汽朋克', '武侠', '江湖', '克苏鲁', '异世界',
            '穿越', '重生', '游戏', '乡土', '现实', '题材', '背景', '日常', '灵异', '日系',
            '我的世界', '反乌托邦', '玄幻', '轻小说', '二次元', 'minecraft', '贫穷', '贫困',
            '底层', '父权', '民俗', '古董', '盗墓', '西幻', '高武', '动漫', '小说', '文学',
            '原创', '同人', '桌游', '神话', '传说', '民间', '军事', '政治', '怪谈', '异象',
            '末世', '深渊', '多元宇宙', 'anime', 'manga', 'video game', 'videogame', 'game',
            'games', 'roleplay', 'novelai', 'lightnovel', 'science fiction', 'superhero',
            'technology', 'entertainment', 'parody', 'folklore', 'wuxia', 'supernatural',
            'paranormal', 'science', 'fictional', 'fictional character', 'interspecies',
            'movie', 'cosplay', 'folk', 'doujin', 'realistic', 'original', 'urban',
            '科技', '跨次元', '多种族', '动态', 'fantasy', 'sci-fi', 'cyberpunk', 'steampunk',
            'isekai', '东北', '二创', '航海']
    },
    {
        key: 'setting',
        keywords: ['校园', '学园', '学校', '职场', '医院', '监狱', '城市', '太空', '小镇', '酒馆',
            '逃课', '居家', '建筑', '夏日', '海岛', '马戏团', '箱庭', '农村', '乡村', '场景',
            '翘课', '跷课', '都市', '诊所', '温泉', '民宿', '公路', '大学', '学院', '办公室',
            '健身房', '公园', '森林', '露营', 'christmas', 'home', 'homeless', 'camping',
            'church', 'college', 'office', 'beach', 'onsen', 'hot spring', 'salon', 'discord',
            'online', 'phone', 'school', 'workplace', 'prison', 'hospital', 'city', 'space',
            '上海', '北京', '宿舍', '孤儿院', '公寓', '庄园', '城堡', '皇宫', '战场', '山脉',
            '海洋', '洞穴', '教室', '混浴', '城中村', '市井', '孤岛', '岛屿', '古刹']
    },
    {
        key: 'mood',
        keywords: ['纯爱', '温馨', '胃疼', '情感', '虐心', '黑暗', '日式黑暗', '偷情', '治愈',
            '致郁', '虐恋', '恋爱', '浪漫', '暧昧', '压抑', '青春', '爱情', '纯情', '出轨',
            '艳遇', '暗黑', 'cuddles', 'dating', 'emotion', 'angst', 'drama', 'love',
            'true love', 'romantic', 'cozy', 'comfort', 'relaxation', 'bittersweet',
            'fluff', 'wholesome', 'dark', 'romance', '暗恋', '单恋', '初恋', '失恋', '三角恋']
    },
    {
        key: 'plot',
        keywords: ['剧情', '冒险', '恐怖', '群像', '双人', '王朝', '神隐', '万象', '犯罪', '悬疑',
            '推理', '堕落', '恶堕', '战斗', '动作', '搞笑', '轻松', '喜剧', '慢热', '背叛',
            '权谋', '正剧', '血腥', '暴力', '创伤', '救赎', '禁忌', '契约', '惊悚', '冥婚',
            '灾难', '畸形', '复仇', '战争', '谍战', '军事', '阴谋', '权力', '爽文', '热血',
            '无敌流', '无限流', '黑色幽默', '幽默', '宫斗', '宫廷斗争', '阶级', '阶级差异',
            '阶级跃迁', '阴谋', '伦理', '前世今生', '主线', '征服', '成长', '劇情', '霸凌',
            '跟踪', '社会伦理', '社会讽刺', '权力斗争', '崩坏', '委托', '忏悔', '无约束',
            '无道德', '欲望', '濒死', '硬核', '等级', '药物', '金手指', '雌竞', '史诗',
            '医疗', '社会实验', 'adventure',
            'combat', 'violence', 'revenge', 'transformation',
            'body swap', 'gaslighting', 'mystery', 'apocalypse', 'dystopian', 'politics',
            'political', 'religion', 'worldbuilding', 'betrayal', 'conspiracy', 'gore',
            'blackmail', 'addiction', 'drug', 'adultery', 'cheating', 'drama', 'duo', 'group',
            'plot', 'secret life', 'immortal', 'time', 'mind reader', 'possession',
            'philosophy', 'social experiment', 'revenge', 'slowburn', 'hunting', 'defeat',
            'capture', 'torture', 'ntr', 'action', 'horror', 'comedy', 'slow burn', 'corruption',
            '身份反转', '轮回', '谎言成真', '调查', '狩猎', '欠债', '讨债', '破产', '俘虏', '海战',
            '诡异', '微恐', '童年阴影']
    }
];

// 向量分类结果缓存（响应式 Map：规则未命中的标签经向量归类后写入，computed 自动追踪）
export const tagCategoryOverrides = ref(new Map());

// 🛠️ 用户自定义大分类（App.vue 装载/持久化，标签云展示时并入内置分类之后）
export const customTagCategories = ref([]); // [{key, name, icon}]
// 🎯 用户手动标签归属（小写标签 → 自定义分类 key，优先级高于所有自动分类）
export const customTagAssignments = ref(new Map());

/**
 * App.vue 装载自定义分类状态（恢复配置时调用）
 * @param {Array} categories [{key, name, icon}]
 * @param {object} assignments {标签: 分类key}
 */
export function setCustomTagState(categories, assignments) {
    customTagCategories.value = Array.isArray(categories)
        ? categories.filter(c => c && c.key && c.name)
            .map(c => ({ key: String(c.key), name: String(c.name), icon: String(c.icon || '🏷️') }))
        : [];
    const m = new Map();
    if (assignments && typeof assignments === 'object') {
        for (const [k, v] of Object.entries(assignments)) {
            if (k && v) m.set(String(k).toLowerCase().trim(), String(v));
        }
    }
    customTagAssignments.value = m;
}

// 分类描述 → key 的映射表（batchMatch 返回 labelPool 原始字符串，需反查）
const descToKey = new Map(
    TAG_CATEGORIES.filter(c => c.key !== 'other').map(c => [CATEGORY_DESCRIPTIONS[c.key], c.key])
);

// 关键词规则匹配（不含斜杠/缓存逻辑的纯规则层）
function classifyByRules(t) {
    for (const rule of RULES) {
        for (const kw of rule.keywords) {
            if (t.includes(kw)) return rule.key;
        }
    }
    return null;
}

// 🔧 规则层结果记忆化缓存：RULES 为模块级常量 → 同一标签的规则结果永不失效，可安全缓存。
//    避免万卡库/大库（1520+ 标签 × 上千关键词）在弹窗打开、勾选、搜索、标签云渲染、向量归属更新等
//    场景反复对全量标签做子串扫描（卡顿根因）。命中后每次分类降到 Map O(1)。
//    ⚠️ 只缓存「纯规则层」结果（含斜杠首段规则），不缓存用户归属/向量缓存——那两者变化需实时读取。
const classifyByRulesCache = new Map();
function classifyByRulesMemo(t) {
    if (classifyByRulesCache.has(t)) return classifyByRulesCache.get(t);
    const r = classifyByRules(t);
    if (classifyByRulesCache.size > 50000) classifyByRulesCache.clear(); // 防无限增长兜底
    classifyByRulesCache.set(t, r);
    return r;
}

/**
 * 获取单个标签所属的大分类 key：
 *   ① 斜杠复合词首段优先 ② 关键词规则 ③ 向量缓存 ④ 'other'
 */
export function getTagCategory(tag) {
    const t = String(tag || '').toLowerCase().trim();
    if (!t) return 'other';
    // ⓪ 用户手动归属（最高优先级：用户说了算，覆盖所有自动分类）
    const assigned = customTagAssignments.value.get(t);
    if (assigned) return assigned;
    // 精确匹配特例（单字词避免用子串匹配误伤，如 'ai' 会命中 maid、'sm' 会命中 smut）
    if (t === 'ai') return 'cardtype';
    if (t === 'sm' || t === 's&m') return 'sexual';
    if (t === 'xp' || t === 'xp合集' || t === 'xp大全') return 'sexual';
    if (t === 'gm' || t === 'mc') return 'cardtype';
    if (t === 'cnc') return 'sexual';
    if (t === 'rp' || t === 'oc') return 'cardtype';
    if (t === 'sub') return 'personality';
    if (t === 'jk') return 'occupation'; // 女子高生/制服（短词子串易误伤，精确特例）
    if (t === 'cot') return 'cardtype'; // Chain-of-Thought 提示链卡
    if (t === 'dom') return 'personality';
    if (t === 'gay') return 'rating';
    if (t === 's') return 'personality';
    if (t === 'm') return 'personality';
    // ① 斜杠复合词（「主仆/女仆」）先按首段分类——复合词首义即标签作者的首选语义
    const slashIdx = t.indexOf('/');
    if (slashIdx > 0) {
        const head = t.slice(0, slashIdx).trim();
        const headCat = head ? classifyByRulesMemo(head) : null;
        if (headCat) return headCat;
    }
    // ② 全词关键词规则（走记忆化缓存，避免大库反复扫描关键词）
    const ruleHit = classifyByRulesMemo(t);
    if (ruleHit) return ruleHit;
    // ③ 向量语义兜底缓存
    const cached = tagCategoryOverrides.value.get(t);
    if (cached) return cached;
    return 'other';
}

/**
 * 按大分类分组标签数组 → [{key, name, icon, custom?:boolean, tags:[...]}]（空分类自动剔除）
 * 分组顺序：内置分类（其他除外）→ 用户自定义分类 → 其他
 */
export function groupTagsByCategory(tags) {
    const builtIn = TAG_CATEGORIES.filter(c => c.key !== 'other');
    const allCats = [
        ...builtIn.map(c => ({ ...c, custom: false, tags: [] })),
        ...customTagCategories.value.map(c => ({ ...c, custom: true, tags: [] })),
        { key: 'other', name: '其他', icon: '🏷️', custom: false, tags: [] }
    ];
    const idx = new Map(allCats.map((c, i) => [c.key, i]));
    for (const tag of Array.isArray(tags) ? tags : []) {
        const key = getTagCategory(tag);
        const i = idx.get(key);
        allCats[i === undefined ? allCats.length - 1 : i].tags.push(tag);
    }
    return allCats.filter(g => g.tags.length > 0);
}

/**
 * 🧠 向量模型辅助分类（策略③层兜底）
 * 规则未命中的标签 → 展开为描述句 → 与各分类描述做余弦相似度匹配 → 写入响应式缓存。
 * 复用主进程 vectorEngine.batchMatch（零新增 IPC），模型未就绪时静默跳过（规则兜底）。
 * @returns 成功分类的标签数
 */
export async function classifyTagsByVector(labels, electronAPI, { threshold = 0.32 } = {}) {
    if (!electronAPI || !electronAPI.vectorEngine || typeof electronAPI.vectorEngine.batchMatch !== 'function') return 0;
    const descs = TAG_CATEGORIES.filter(c => c.key !== 'other').map(c => CATEGORY_DESCRIPTIONS[c.key]);
    // 只分类「规则未命中 + 尚无缓存」的标签
    const unknown = [...new Set(Array.isArray(labels) ? labels : [])].filter(l => {
        const t = String(l || '').toLowerCase().trim();
        if (!t || tagCategoryOverrides.value.has(t)) return false;
        return getTagCategory(t) === 'other';
    });
    if (unknown.length === 0) return 0;
    try {
        const payloads = unknown.map(l => ({ id: l, name: l, text: `这是一个关于${l}的标签` }));
        const resp = await electronAPI.vectorEngine.batchMatch(payloads, descs, 1, threshold);
        if (resp && resp.success && Array.isArray(resp.results)) {
            let changed = 0;
            const next = new Map(tagCategoryOverrides.value);
            for (const r of resp.results) {
                if (r.tags && r.tags.length > 0) {
                    const key = descToKey.get(r.tags[0]);
                    if (key && key !== 'other') {
                        next.set(String(r.id).toLowerCase().trim(), key);
                        changed++;
                    }
                }
            }
            if (changed > 0) tagCategoryOverrides.value = next; // 整体替换触发响应式
            return changed;
        }
    } catch (e) {
        console.warn('🧠 向量辅助标签分类失败（回退规则兜底）:', e && e.message ? e.message : e);
    }
    return 0;
}

// =========================================================
// 🤖 AI 大模型标签分类：把「分类规则」编译成给 LLM 的系统提示词
// （"最终兵器"：本地规则 + 向量都难判的未知标签，交给大模型按语义归类）
// =========================================================

/** 分类清单 → 系统提示词（内置 17 类语义 + 用户自定义分类 + 判定纪律） */
export function buildTagClassificationSystemPrompt(customCats = []) {
    const L = [];
    L.push('你是一名「角色卡(SillyTavern 角色卡)标签分类助手」。用户会提供一批卡片上出现的、尚未归类的标签，');
    L.push('你需要把其中每一个标签归入下面给出的「大分类」之一。');
    L.push('');
    L.push('可用大分类（key 用于输出）：');
    for (const c of TAG_CATEGORIES) {
        if (c.key === 'other') continue;
        L.push(`- ${c.key}（${c.name}）：${CATEGORY_DESCRIPTIONS[c.key]}`);
    }
    const customs = (Array.isArray(customCats) ? customCats : []).filter(c => c && c.key && c.name);
    for (const c of customs) {
        L.push(`- ${c.key}（${c.icon || '🏷️'}${c.name}）：用户自定义分类，语义以分类名为准（例如「游戏作品」收录各游戏/IP 名）`);
    }
    L.push(`- other（其他）：无法明确归入上述任何分类的标签。`);
    L.push('');
    L.push('判定纪律（严格遵守）：');
    L.push('1. 能归入现有大分类的标签，务必归入最贴合的一个；拿不准 → 参考纪律 2/3。');
    L.push('2. 作品/IP/角色等专名：只有能与其他标签聚成清晰类别时（见纪律 3）才一起建组；否则一律归 other，绝不单独为一个专名建分类。');
    L.push('3. 自拟新分类（成组才用，最后手段）：当一批标签无法落入任何现有分类、但语义明显同属一个清晰类别时，为整批标签自拟【同一个简洁中文类名(2~6字)】作为它们的分类值。');
    L.push('   示例：同批含「2B、甘雨、尼尔：机械纪元」等多个游戏相关标签 → 可自拟「游戏角色」统一承接；同批含「安达与岛村、大耳朵图图」等多部动画 → 可自拟「番剧动画」。');
    L.push('4. 严禁为单个孤立标签自造分类（孤立专名/散杂垃圾标签归 other）；严禁用长句/网址/纯符号作类名；类名须为简洁中文。');
    L.push('5. 有歧义时按该词最常用、最稳定的语义判断；一词只归一类，严禁重复列出同一标签。');
    L.push('6. 若现有自定义分类（如「游戏作品」）已能容纳某标签，优先归入该自定义分类，不要重复自拟同名新类。');
    L.push('7. 输出键必须是被归类标签的“原始原文”，大小写、符号原样保留。');
    L.push('');
    L.push('输出要求：只输出一个 JSON 对象，键=标签原文，值=“现有分类 key / other / 自拟简洁中文类名”三选一。不要任何解释、代码块围栏或额外文字。');
    return L.join('\n');
}

/** 把待分类标签数组格式化成 user 消息（编号换行，含数量头） */
export function buildTagClassificationUserPrompt(labels = []) {
    const list = (Array.isArray(labels) ? labels : []).filter(l => l !== undefined && l !== null && String(l).trim() !== '');
    if (list.length === 0) return '';
    return '以下是待分类的标签（共 ' + list.length + ' 个）：\n' +
        list.map((l, i) => `${i}. ${l}`).join('\n') +
        '\n\n请输出 JSON：{ "标签原文": "分类key" }';
}

// =========================================================
// 🆕 AI 归类「新分类名」归一（v2.2.1 增强）
// 模型返回的分类值可能是：现有 key / 现有中文名 / other / 自拟的新分类名。
// 逐层归一：命中现有（内置 key/中文名、自定义 key/name）→ 返回其 key；
// 其余通过合理性过滤后 → 视为「待新建的自定义大分类名」（isNew=true），
// 由 TagCategoryModal 在应用时自动 addCustomTagCategory 创建并承接标签。
// =========================================================
const BUILTIN_TARGETS = (() => {
    const keys = new Set();
    const names = new Map(); // 中文名(规范化) → key
    for (const c of TAG_CATEGORIES) {
        if (c.key === 'other') continue;
        keys.add(c.key);
        names.set(normalizeTagName(c.name).toLowerCase(), c.key);
    }
    return { keys, names };
})();

/**
 * 🔤 分类名/标签名规范化（用于判重）：
 * 删除零宽字符/BOM，把全角空格、NBSP、变体空白统一为半角空格，折叠连续空白并去首尾。
 * —— 防止“看起来同名但字节不同”（如模型输出尾随 NBSP/全角空格/零宽）被当成不同分类重复创建。
 */
export function normalizeTagName(value) {
    return String(value == null ? '' : value)
        .replace(/[\u200b\u200c\u200d]/g, '') // 零宽字符删除
        .replace(/\ufeff/g, '') // BOM 删除
        .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, ' ') // 变体/全角空白 → 半角空格
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 把 AI 返回的分类值归一为可用目标
 * @param {*} value 模型输出的分类值（key / 中文名 / other / 自拟新名）
 * @param {Array} customCats 当前自定义大分类 [{key,name,icon}]（归一现有自定义）
 * @returns {{ key:string, isNew:boolean }} key=最终分类 key 或新类名；isNew=是否需要自动新建
 */
export function resolveTagCategoryTarget(value, customCats = []) {
    const raw = normalizeTagName(value);
    if (!raw) return { key: 'other', isNew: false };
    const low = raw.toLowerCase();
    if (low === 'other') return { key: 'other', isNew: false };
    // ① 命中现有内置分类（key 或中文名）
    if (BUILTIN_TARGETS.keys.has(low)) return { key: low, isNew: false };
    if (BUILTIN_TARGETS.names.has(low)) return { key: BUILTIN_TARGETS.names.get(low), isNew: false };
    // ② 命中现有自定义分类（key 或 name，规范化比较）
    const customs = Array.isArray(customCats) ? customCats : [];
    const c = customs.find(x => x && x.key && (String(x.key).trim().toLowerCase() === low || normalizeTagName(x.name).toLowerCase() === low));
    if (c) return { key: c.key, isNew: false };
    // ③ 合理性过滤后视为新分类候选（拒绝超长 / 纯符号数字 / 空白）
    if (raw.length > 12) return { key: 'other', isNew: false };
    if (!/[A-Za-z\u4e00-\u9fa5]/.test(raw)) return { key: 'other', isNew: false };
    return { key: raw, isNew: true };
}

