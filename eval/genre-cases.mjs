// Genre vocabulary cases for the keyword suggester — the data half; eval/genre-check.mjs runs it.
// A case is { genre, shape, text, expect: [...], reject: [...] }: expect terms must be offered, reject must not, both compared against the lowercased ranking term.
// Cases carry the SHAPE, never anyone's actual writing.

/** Filler prose, deliberately bland and varied: the padding must not become a signal itself. */
const FILLER = [
    'Rain fell on the street tonight, a dull ordinary evening for everyone here.',
    'The market closed early, and the road home was quiet enough to hear the river.',
    'Nothing of note happened that afternoon, though the weather turned before dusk.',
    'A slow week followed, with little to record beyond the usual rounds and errands.',
    'The season turned. Days grew shorter, and the halls emptied earlier each night.',
];

/**
 * Wraps one entry's text in neutral filler so the corpus-wide gates behave as on a real book; cases must never hand-roll their own padding.
 * @param {string|string[]} text the entry under test (uid 0)
 * @param {number} [pad=14] filler entries around it
 */
export function paddedBook(text, pad = 14) {
    const list = Array.isArray(text) ? text : [text];
    const entries = {};
    list.forEach((t, i) => { entries[i] = { uid: i, key: [], content: t }; });
    for (let i = 0; i < pad; i++) entries[list.length + i] = { uid: list.length + i, key: [], content: FILLER[i % FILLER.length] };
    return { entries };
}

export const SUGGEST_OPTS = { dfCeil: 0.35, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 12 };

export const GENRE_CASES = [
    // --- LitRPG / dungeon system --------------------------------------------------------------
    {
        // Chrome repeats, so several entries carry the tag; with one the frequency gates cannot see it.
        genre: 'litrpg', shape: 'system bracket tag',
        text: [
            '[SKILL ACQUIRED: Mana Weaving]\nThe sigil granted Mana Weaving to the party. Mana Weaving held for an hour, and Mana Weaving faded at dawn.',
            '[SKILL ACQUIRED: Ember Step]\nThe brazier taught Ember Step to the scout.',
            '[SKILL ACQUIRED: Silent Tread]\nA shrine offered Silent Tread to anyone who knelt.',
            '[SKILL ACQUIRED: Iron Ward]\nThe forge granted Iron Ward before the descent.',
        ],
        pad: 6,
        expect: ['mana weaving'],
        reject: ['skill acquired', 'skill', 'acquired'],   // interface chrome, not content
    },
    {
        genre: 'litrpg', shape: 'level and stat notation',
        text: [
            'The Ashgate warden reached Lv3 that night. An Ashgate warden at Lv3 carries HP 25, so the Ashgate warden waited.',
            'A courier reached Lv2 with HP 18 and turned back before the gate.',
            'The scout held Lv4 and HP 30 through the second descent.',
            'Every delve begins at Lv1 with HP 10, whatever the pledge.',
        ],
        // Four of ten entries carry the stat notation, which is what puts HP over the frequency gates.
        pad: 6,
        expect: ['ashgate'],
        reject: ['lv', 'hp', 'warden'],   // "warden" is a common noun, not this book's coinage
    },
    {
        genre: 'litrpg', shape: 'label bullet lines',
        text: '- Devoted: the thrall answers a summons without hesitation.\n- Devoted: the bond deepens with every trial the thrall survives.',
        expect: [],
        reject: ['devoted', 'thrall'],   // a bare adjective is a poor trigger; "thrall" is genre-common, not this book's coinage
    },

    // --- High fantasy --------------------------------------------------------------------------
    {
        genre: 'fantasy', shape: 'apostrophe name',
        text: "The warlock Kal'thas Sunstrider held the tower. Nobody defied Kal'thas Sunstrider twice.",
        expect: ["kal'thas sunstrider", "kal'thas", 'sunstrider'],
        reject: ['warlock kal\'thas sunstrider'],
    },
    {
        // Both forms in one entry on purpose: only the vowel test tells D'Vorah from an elision.
        genre: 'fantasy', shape: 'apostrophe name that looks like an elision',
        text: "The warlord D'Vorah led the swarm, and Vorah kept the hive quiet while D'Vorah slept and Vorah watched.",
        expect: ["d'vorah", 'vorah'],
        reject: ["d'vorah led"],
    },
    {
        genre: 'fantasy', shape: 'possessive of an apostrophe name',
        text: "Kal'thas Sunstrider guarded the tower. Kal'thas's staff never left the tower, and Kal'thas' sigil burned above it.",
        expect: ["kal'thas"],
        reject: ["kal'thas's", "kal'thas'", "kal'tha"],   // the fold must not mangle the name
    },
    {
        // Bullet-led, so no mid-sentence capital: the name must survive on the no-lowercase test alone.
        genre: 'any', shape: 'name that looks like a gerund, in bullet-led prose',
        text: '- Tenzing arrives at camp.\n- Tenzing refuses the third route.\n- Tenzing waits for weather.',
        expect: ['tenzing'],
        reject: ['arrives', 'camp'],
    },
    {
        genre: 'any', shape: 'real gerund, and a common sentence-opener',
        text: [
            'Rumors kept solidifying around the camp. Sales kept solidifying through winter, and doubt kept solidifying.',
            'Nothing came of it that week. Nothing changed by spring. Nothing was said of the ridge again.',
        ],
        expect: [],
        reject: ['solidifying', 'nothing'],   // neither may ride in on the name exemption
    },
    {
        genre: 'fantasy', shape: 'hyphenated species compound',
        text: 'The stone-singers of the Quartzborn clan gathered. Every stone-singer answered the Quartzborn call that season.',
        expect: ['quartzborn'],
        reject: ['stone-singers'],   // the singular already matches the plural as a substring
    },
    {
        genre: 'fantasy', shape: 'invented faction with English linker',
        text: [
            'They swore to the Order of the Unconquered Sun. Every knight of the Order of the Unconquered Sun kept the vigil.',
            'The steward wrote in order to settle the accounts, and put the ledgers in order before dusk.',
        ],
        expect: ['order of the unconquered sun'],
        // The second entry's "in order to" is what makes bare "Order" not a name.
        reject: ['order of the unconquered', 'of the unconquered sun', 'order'],
    },

    // --- Historical / court --------------------------------------------------------------------
    {
        genre: 'court', shape: 'nobiliary particle',
        text: 'They bowed to Vicomtesse de Sacres. The room watched Vicomtesse de Sacres depart without a word.',
        expect: ['sacres', 'vicomtesse de sacres'],
        reject: ['de sacres', 'vicomtesse de'],
    },
    {
        genre: 'court', shape: 'toponym title in its own place',
        text: 'The duchy of Bourgogne lay east of the river. The Duc de Bourgogne ruled Bourgogne for thirty years, and the Duc de Bourgogne died there.',
        expect: ['bourgogne', 'duc de bourgogne'],
        reject: ['de bourgogne'],
    },
    {
        genre: 'court', shape: 'English locative needs its title',
        text: 'The Bishop of Queensgrace blessed the fleet. Sailors still speak of the Bishop of Queensgrace.',
        expect: ['bishop of queensgrace'],
        reject: ['of queensgrace', 'bishop of'],
    },
    {
        genre: 'court', shape: 'roman numeral regnal name',
        text: 'A portrait of Louis XIII hung in the gallery. Beneath it, a smaller Louis XIII faced the window.',
        expect: ['louis xiii'],
        reject: ['xiii'],
    },

    // --- Contemporary --------------------------------------------------------------------------
    {
        genre: 'contemporary', shape: 'acronym and brand',
        text: 'The SDG office installed a La Marzocco last spring. Staff queue at the La Marzocco before the SDG standup.',
        expect: ['sdg', 'marzocco'],
        // The article goes: "Marzocco" already matches every "La Marzocco".
        reject: ['la marzocco']
    },
    {
        genre: 'contemporary', shape: 'shouted markdown header',
        text: '# THE OFFERING-FISH\n\nThe offering-fish keep their own counsel. Nobody bothers an offering-fish twice, and an offering-fish rarely explains.',
        expect: ['offering-fish'],
        reject: ['the offering-fish'],
        display: { 'offering-fish': 'offering-fish' },   // prose spelling wins over the shouted header
    },

    // --- Cross-genre ---------------------------------------------------------------------------
    {
        genre: 'any', shape: 'accented name',
        text: 'The duchy of Orléans passed to his heir. The heir held Orléans until his death, and Orléans mourned him.',
        expect: ['orléans'],
        // NOT rejecting "duchy": a fair candidate on its own.
        reject: ['of orléans', 'the duchy'],
    },
    {
        // Both spellings on purpose: only the curly form regresses.
        genre: 'any', shape: 'curly-apostrophe contractions',
        text: [
            'The steward isn’t convinced, and the ledger doesn’t balance. He isn’t sure the Verenthian tally isn\'t short.',
            'She doesn’t argue. The clerk isn’t listening, and the Verenthian tally doesn’t change.',
        ],
        expect: ['verenthian'],
        reject: ['isn’t', 'doesn’t', "isn't", 'isn’t convinced', 'steward isn’t'],
    },
    {
        // "I" is never written lowercase, so grammar, not properness, is why the capital is there.
        genre: 'any', shape: 'first-person contractions',
        text: [
            "I've walked the Verenthian road before. I'm sure I've seen the mile-stones, and I'd know them again.",
            "I've counted them twice. I'm certain of it, and I'd say so to the steward.",
        ],
        expect: ['verenthian'],
        reject: ["i've", "i'm", "i'd", "i've walked", "i've seen"],
    },
    {
        // The relative clauses are what make this case fail without the shape rule, not decoration.
        genre: 'any', shape: 'proper noun plus contraction',
        text: [
            "Boulder hasn't lost a duel. Anything that hasn't been tried, Boulder hasn't feared.",
            "He hasn't noticed. She hasn't either, and the thing that hasn't happened yet still worries the Verenthian scouts.",
            "Boulder hasn't made camp. Verenthian scouts say he hasn't slept, and what hasn't been said hasn't been forgotten.",
        ],
        expect: ['boulder'],
        reject: ["boulder hasn't", "hasn't", "hasn't lost", "he hasn't"],
    },
    {
        genre: 'any', shape: 'clause fragment from machine-written prose',
        text: 'Jeffrey self-deprecatingly debunks the myth. Later Jeffrey self-deprecatingly debunks it again for the room.',
        expect: ['jeffrey'],
        reject: ['jeffrey self-deprecatingly', 'self-deprecatingly debunks', 'debunks'],
    },
];
