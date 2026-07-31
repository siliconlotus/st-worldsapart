// Genre vocabulary cases for the keyword suggester — the data half; eval/genre-check.mjs runs it.
//
// WHY THIS EXISTS. Roleplay prose is not the English the frequency tables were built from, and
// every genre breaks the ranker somewhere different. Measured over one user's 35 books, the shapes
// that actually occur are: acronyms (30 books), bracket tags (26), apostrophe names (20), accented
// text (18), nobiliary particles (15), hyphenated species compounds (12), shouted markdown headers
// (9), elisions (8), roman numerals (8) and LitRPG stat blocks (7). Nearly every bug found while
// tuning the suggester came from one of those and not from ordinary prose.
//
// Cases carry the SHAPE, never anyone's actual writing: the point is that a name has a particle or
// a header is shouted, not what the scene is about. Neutral vocabulary keeps the suite publishable.
//
// Adding a case is four lines, which is the point — when a suggestion looks wrong, write down the
// text that produced it rather than reasoning about which gate misfired.
//   { genre, shape, text, expect: [...], reject: [...] }
// `expect` terms must be offered for that entry, `reject` must not. Both are compared against the
// lowercased ranking term (not the display form), so casing is irrelevant here.

/** Filler prose, deliberately bland and varied: the padding must not become a signal itself. */
const FILLER = [
    'Rain fell on the street tonight, a dull ordinary evening for everyone here.',
    'The market closed early, and the road home was quiet enough to hear the river.',
    'Nothing of note happened that afternoon, though the weather turned before dusk.',
    'A slow week followed, with little to record beyond the usual rounds and errands.',
    'The season turned. Days grew shorter, and the halls emptied earlier each night.',
];

/**
 * Wrap one entry's text in enough neutral filler that the corpus-wide gates behave as they would on
 * a real book. This is not decoration: a term appearing in 3 of 9 entries lands over the >30% share
 * that the distributional function-word cut treats as a stopword, which silently strips it from
 * every n-gram. Two separate debugging sessions were lost to exactly that before this helper
 * existed, so cases should never hand-roll their own padding.
 * @param {string} text     the entry under test (uid 0)
 * @param {number} [pad=14] filler entries to surround it with
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
    // Notation taken from real books: "[State]", "[FROZEN - Victory]", "Lv1", "HP 25", "- Devoted:".
    {
        // Chrome repeats — that is what makes it chrome — so the case supplies several entries
        // carrying the tag. With one entry the frequency gates cannot see it and the shouted words
        // ride in on the acronym exemption, which is a property of the fixture, not the ranker.
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
        // Four of ten entries carry the stat notation, which is what a real stat-block book looks
        // like — and what puts "HP" over the frequency gates. Below that it rides in on the acronym
        // exemption, indistinguishable from a genuine initialism like SDG.
        pad: 6,
        expect: ['ashgate'],
        reject: ['lv', 'hp', 'warden'],   // "warden" is a common noun, not this book's coinage
    },
    {
        genre: 'litrpg', shape: 'label bullet lines',
        text: '- Devoted: the thrall answers a summons without hesitation.\n- Devoted: the bond deepens with every trial the thrall survives.',
        expect: ['thrall'],
        reject: ['devoted'],   // a bare adjective is a poor trigger
    },

    // --- High fantasy --------------------------------------------------------------------------
    {
        genre: 'fantasy', shape: 'apostrophe name',
        text: "The warlock Kal'thas Sunstrider held the tower. Nobody defied Kal'thas Sunstrider twice.",
        expect: ["kal'thas sunstrider", "kal'thas", 'sunstrider'],
        reject: ['warlock kal\'thas sunstrider'],
    },
    {
        // Apostrophe names are ordinary tokens and need no special handling — but they are
        // structurally identical to a French elision, so the rule that turns "d'Orléans" into
        // "Orléans" could just as easily eat a fantasy name. What protects it is the same-entry
        // guard: the bare form has to be available HERE for the elided one to give way.
        genre: 'fantasy', shape: 'apostrophe name that looks like an elision',
        text: [
            "The warlord D'Vorah led the swarm. Nobody crossed D'Vorah twice that season.",
            'Later Vorah spoke of the swarm, and Vorah kept the hive quiet.',
        ],
        expect: ["d'vorah"],
        reject: ['vorah'],
    },
    {
        genre: 'fantasy', shape: 'possessive of an apostrophe name',
        text: "Kal'thas Sunstrider guarded the tower. Kal'thas's staff never left the tower, and Kal'thas' sigil burned above it.",
        expect: ["kal'thas"],
        reject: ["kal'thas's", "kal'thas'", "kal'tha"],   // the fold must not mangle the name
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
        // Bare "Order" only looks like a name in a corpus that never writes "in order to" — which
        // is why the second entry is here. Properness is a ratio, so one ordinary use is enough.
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
        // The article goes: as a substring key "Marzocco" already matches every "La Marzocco", and
        // the remainder is distinctive enough to stand (unlike "de la Cruz" -> "Cruz").
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
        // NOT rejecting "duchy": it is an uncommon enough word to be a fair candidate on its own.
        reject: ['of orléans', 'the duchy'],
    },
    {
        genre: 'any', shape: 'clause fragment from machine-written prose',
        text: 'Jeffrey self-deprecatingly debunks the myth. Later Jeffrey self-deprecatingly debunks it again for the room.',
        expect: ['jeffrey'],
        reject: ['jeffrey self-deprecatingly', 'self-deprecatingly debunks', 'debunks'],
    },
];
