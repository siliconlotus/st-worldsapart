const SETTINGS_HTML = `
<style>
/* Nested WA sub-sections read as subordinate to the top "Worlds Apart" header: indented, lighter,
   smaller, with a left rule — so they don't look like their own top-level drawers. */
.worlds-apart-settings .wa-section { margin-left: 10px; border-left: 2px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); padding-left: 8px; }
.worlds-apart-settings .wa-section > .inline-drawer-toggle { font-size: 0.95em; opacity: 0.8; }
.worlds-apart-settings .wa-section > .inline-drawer-toggle b { font-weight: 500; }
.worlds-apart-settings small.opacity50p { display: block; margin: 0.15em 0 0.8em; }
</style>
<div class="worlds-apart-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Worlds Apart</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="wa_plugin_alert"></div>
            <label class="checkbox_label" for="wa_enabled">
                <input id="wa_enabled" type="checkbox"><span>Enabled</span>
            </label>
            <label>Prompt insertion order <span class="fa-solid fa-circle-question note-link-span" title="The order selected entries take in the prompt. A base sort, with optional tier grouping. This setting is saved; the Studio's sort views are not."></span></label>
            <div id="wa_presentation_order_mount" style="margin-top:4px;"></div>

            <label for="wa_message_depth">Message depth</label>
            <input id="wa_message_depth" type="number" class="text_pole" min="1" max="20" step="1">

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Tier precedence</b> <span class="fa-solid fa-circle-question note-link-span" title="With tier grouping on, an entry joins the first tier it matches, top to bottom. Untick a tier to skip it. Shared with the Studio."></span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div id="wa_tier_editor_mount" style="margin-top:4px;"></div>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Match window</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_drop_chat_tags">Ignore these HTML tags in chat <span class="fa-solid fa-circle-question note-link-span" title="Comma-separated tags to be skipped when scanning for keyword hits. You might want to set this to your preset's internal state tracker so your quest tracker doesn't constantly pull entries."></span></label>
                    <input id="wa_drop_chat_tags" type="text" class="text_pole" placeholder="internal_states, thinking">

                    <label for="wa_match_window">Match window <span class="fa-solid fa-circle-question note-link-span" title="The span within which a key's conditions must all match, e.g. ? apple AND banana must both appear in the same paragraph, message or scan window."></span></label>
                    <select id="wa_match_window" class="text_pole">
                    <option value="paragraph">Paragraph</option>
                    <option value="message">Message</option>
                    <option value="scan">Whole scan window (SillyTavern default)</option>
                    </select>

                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Matching &amp; relevance</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_word_boundary">Word boundary <span class="fa-solid fa-circle-question note-link-span" title="Applies to entries with Match Whole Words on and SmartKeys that use =. Permissive: whole-word &quot;Joe&quot; matches &quot;Joe's&quot;. Strict: no match. Neither matches &quot;Joes&quot;."></span></label>
                    <select id="wa_word_boundary" class="text_pole">
                    <option value="strict">Strict: hyphens and apostrophes are part of a word</option>
                    <option value="permissive">Permissive: only letters and digits are</option>
                    </select>

                    <div id="wa_embed_info" class="opacity50p" style="margin:0.4em 0;font-size:0.85em;" title="Set the embedding model in the Vector Storage extension."></div>

                    <label>Mean-centered search</label>
                    <div id="wa_plugin_setup" style="margin:0.4em 0;font-size:0.85em;opacity:0.75;"></div>

                    <div id="wa_find_orphans" class="menu_button" style="width:auto;padding:0.3em 0.8em;" title="Lists vector collections no current book claims. Nothing is deleted.">Find unused vector collections…</div>
                    <div id="wa_orphans_out" class="opacity50p" style="margin:0.4em 0;font-size:0.85em;"></div>

                    <label class="checkbox_label" for="wa_drop_unavailable">
                    <input id="wa_drop_unavailable" type="checkbox"><span>Hide entries from later in the chat</span> <span class="fa-solid fa-circle-question note-link-span" title="On a branch from an earlier point, scene summaries written after that point are hidden. No effect at the latest turn."></span>
                    </label>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Selection &amp; budget</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_relevance_cutoff">Relevance cutoff for memory entries (0 = none)</label>
                    <input id="wa_relevance_cutoff" type="number" class="text_pole" min="0" max="1" step="0.01">

                    <label for="wa_max_entries">Vector entry cap</label>
                    <input id="wa_max_entries" type="number" class="text_pole" min="1" max="100" step="1">

                    <label for="wa_max_dynamic">Dynamic entry cap, keyword and vector (0 = none)</label>
                    <input id="wa_max_dynamic" type="number" class="text_pole" min="0" max="500" step="1">

                    <label for="wa_max_total">Total entry cap, constants included (0 = none)</label>
                    <input id="wa_max_total" type="number" class="text_pole" min="0" max="500" step="1">

                    <label for="wa_max_tokens_pct">Token budget, % of context (0 = off)</label>
                    <input id="wa_max_tokens_pct" type="number" class="text_pole" min="0" max="100" step="1">

                    <label for="wa_max_tokens">Token budget, tokens (0 = off; the tighter of the two applies)</label>
                    <input id="wa_max_tokens" type="number" class="text_pole" min="0" max="100000" step="64">

                    <label for="wa_budget_slack">Budget slack, % over (0 = none)</label>
                    <input id="wa_budget_slack" type="number" class="text_pole" min="0" max="50" step="1">

                    <label for="wa_slack_mode">Slack applies</label>
                    <select id="wa_slack_mode" class="text_pole">
                    <option value="once">Once: one entry may exceed the budget</option>
                    <option value="all">All: every entry may exceed it</option>
                    </select>

                    <label class="checkbox_label" for="wa_tokens_include_exempt">
                    <input id="wa_tokens_include_exempt" type="checkbox"><span>Count "ignore budget" entries against the token budget</span>
                    </label>

                    <small id="wa_exempt_count" class="opacity50p"></small>

                    <label>Lorebook priority <span class="fa-solid fa-circle-question note-link-span" title="How entries from several books compete for the budget and where they sit in the prompt. A book appears here after its first scan."></span></label>
                    <label for="wa_world_priority_mode">Mode</label>
                    <select id="wa_world_priority_mode" class="text_pole">
                    <option value="interleaved">Interleaved: one ranked list, with optional per-book weights</option>
                    <option value="sequential">Sequential: higher books fill first</option>
                    </select>

                    <div id="wa_world_priority_list" style="margin-top:6px;"></div>
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Audit &amp; suggestions</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="wa_language">Language of the lorebook</label>
                    <select id="wa_language" class="text_pole">
                    <option value="en">English</option>
                    </select>
                    <small class="opacity50p" id="wa_language_state"></small>


                    <label for="wa_llm_profile">Suggestion profile <span class="fa-solid fa-circle-question note-link-span" title="Used by the keyword suggester, one call per entry."></span></label>
                    <div class="flex-container alignItemsCenter flexnowrap">
                    <select id="wa_llm_profile" class="text_pole flex1"></select>
                    <div id="wa_refresh_profiles" class="menu_button fa-solid fa-rotate" title="Reload the Connection Manager profile list"></div>
                    </div>

                    <label for="wa_llm_temp">Temperature</label>
                    <input id="wa_llm_temp" type="number" class="text_pole" min="0" max="2" step="0.05" placeholder="backend default">
                </div>
            </div>

            <div class="inline-drawer wa-section">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Advanced</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">


                    <label class="checkbox_label" for="wa_debug_log">
                        <input id="wa_debug_log" type="checkbox"><span>Log the selection table on every generation</span>
                    </label>

                    <label for="wa_rater_id">Rater id <span class="fa-solid fa-circle-question note-link-span" title="A random anonymous ID your grades are signed with."></span></label>
                    <input id="wa_rater_id" type="text" class="text_pole" readonly placeholder="generated on your first grade">


                    <div id="wa_review_bundles" class="menu_button" style="width:auto;padding:0.3em 0.8em;" title="Opens the bundle reviewer without a chat.">Review graded bundles…</div>
                </div>
            </div>
        </div>
    </div>
</div>`;

/** Rebuilds the profile dropdown from Connection Manager's current list; `notify` toasts the result. */
function populateProfiles(notify = false) {
    const profiles = extension_settings.connectionManager?.profiles ?? [];
    const selected = settings().llmProfile;

    $('#wa_llm_profile')
        .empty()
        // Not a neutral fallback: without a profile generateText uses generateRaw, which takes no generation parameters.
        .append([`<option value="">Current chat API</option>`]
            .concat(profiles.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`))
            .join(''));

    // A deleted profile leaves a dangling id: show the fallback, but do not rewrite the setting.
    const stillExists = !selected || profiles.some(x => x.id === selected);
    $('#wa_llm_profile').val(stillExists ? selected : '');

    if (!stillExists) {
        console.warn(`Worlds Apart: saved LLM profile "${selected}" no longer exists, falling back to the current API`);
        toastr.warning('Saved LLM profile no longer exists.', 'Worlds Apart');
    }

    if (notify) {
        toastr.info(`${profiles.length} profile(s) loaded.`, 'Worlds Apart');
    }
}

/** Wires a settings control to its backing value.
 *  @param {'checked'|'number'|'string'} kind */
function bind(selector, key, kind) {
    const $el = $(selector);

    if (kind === 'checked') {
        $el.prop('checked', settings()[key]);
    } else {
        $el.val(settings()[key]);
    }

    $el.on('input change', () => {
        settings()[key] = kind === 'checked' ? $el.prop('checked')
            : kind === 'number' ? Number($el.val())
                : String($el.val());
        saveSettingsDebounced();
    });
}



// The Delivery panel: a bottom-left icon expanding into stage 5's delivered set, in prompt order, from
// runState.lastPromptOrder.
let deliveryTrigger = null, deliveryPanel = null;
function ensureDeliveryPanel() {
    if (deliveryTrigger) return;
    const style = document.createElement('style');
    style.textContent = `
.wa-delivery-trigger { position: fixed; left: 10px; bottom: 10px; z-index: 100000; width: 28px; height: 28px;
    line-height: 28px; text-align: center; cursor: pointer; opacity: 0.6; border-radius: 6px;
    background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.4)); }
.wa-delivery-trigger:hover { opacity: 1; }
.wa-delivery-trigger[data-count]:not([data-count="0"])::after { content: attr(data-count); position: absolute;
    top: -6px; right: -6px; min-width: 14px; height: 14px; line-height: 14px; padding: 0 3px; font-size: 9px;
    text-align: center; color: #fff; background: var(--crimson70a, #b33); border-radius: 8px; }
.wa-delivery-panel { position: fixed; left: 10px; bottom: 46px; z-index: 100000; display: none; flex-direction: column;
    gap: 2px; width: 320px; max-width: calc(100vw - 20px); max-height: 60vh; overflow-y: auto; padding: 6px;
    border-radius: 8px; font-size: 0.85em; background: var(--SmartThemeBlurTintColor, rgba(20,20,20,0.92));
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); }
.wa-delivery-panel.wa-delivery-open { display: flex; }
.wa-delivery-entry { display: flex; align-items: baseline; gap: 6px; padding: 3px 5px; border-radius: 5px; cursor: pointer; }
.wa-delivery-entry:hover { background: var(--white20a, rgba(255,255,255,0.1)); }
.wa-delivery-glyph { flex: 0 0 auto; }
.wa-delivery-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-delivery-empty { opacity: 0.6; padding: 4px; }`;
    document.head.append(style);

    deliveryTrigger = document.createElement('div');
    deliveryTrigger.className = 'wa-delivery-trigger fa-solid fa-fw fa-book-atlas';
    deliveryTrigger.title = 'Worlds Apart — delivered this turn';
    deliveryTrigger.dataset.count = '0';
    deliveryPanel = document.createElement('div');
    deliveryPanel.className = 'wa-delivery-panel';
    deliveryTrigger.addEventListener('click', () => deliveryPanel.classList.toggle('wa-delivery-open'));
    document.body.append(deliveryTrigger, deliveryPanel);
}

function renderDeliveryPanel(layout) {
    ensureDeliveryPanel();
    deliveryTrigger.dataset.count = String(layout.length);
    deliveryPanel.innerHTML = '';
    // Appended last: the panel opens upward, so the bottom row is nearest the icon.
    const lab = document.createElement('div');
    lab.className = 'wa-delivery-entry';
    lab.title = 'Open the Studio on the Keyword Lab';
    lab.innerHTML = '<span class="wa-delivery-glyph fa-solid fa-flask"></span>'
        + '<span class="wa-delivery-title">Open the Keyword Lab</span>';
    lab.addEventListener('click', () => lorebookStudio(chatBook(), { lab: true }));
    if (!layout.length) {
        const empty = document.createElement('div');
        empty.className = 'wa-delivery-empty';
        empty.textContent = 'Nothing delivered yet';
        deliveryPanel.append(empty, lab);
        return;
    }
    for (const row of layout) {
        const e = row.item.entry;
        const el = document.createElement('div');
        el.className = 'wa-delivery-entry';
        el.title = `${wiTooltip(row)}\n\nClick: open in the Explorer · Shift-click: show the text`;
        const g = document.createElement('span');
        g.className = 'wa-delivery-glyph';
        g.textContent = wiGlyph(e);
        const t = document.createElement('span');
        t.className = 'wa-delivery-title';
        t.textContent = wiTitleOf(e);
        el.append(g, t);
        // Click opens the entry in the Explorer; shift-click shows its text alone.
        el.addEventListener('click', ev => {
            if (ev.shiftKey) { showEntryText(e); return; }
            lorebookStudio(e.world ?? chatBook(), { entry: { world: e.world, uid: e.uid } });
        });
        deliveryPanel.append(el);
    }
    deliveryPanel.append(lab);
}

let initialized = false;

export async function init() {
    // Handed the pipeline's entry points once, here, so the dependency runs one way.
    setCaptureHost({ chatBook, coreSelection, dryRun, effectiveTokenBudget, paramSnapshot, scopedPriority, vectorRequestBody });
    // Both `hooks.activate` and the jQuery bootstrap below can reach here.
    if (initialized) {
        return;
    }
    initialized = true;

    ensureSettings(extension_settings);
    // Migrations of stored values from earlier settings shapes.
    if (settings().worldPriorityMode === 'off') settings().worldPriorityMode = 'interleaved';
    if (settings().presentationOrder in PRESENTATION_ALIAS) settings().presentationOrder = PRESENTATION_ALIAS[settings().presentationOrder];
    if (settings().studioTierCfg && !settings().tierCfg) { settings().tierCfg = settings().studioTierCfg; delete settings().studioTierCfg; }
    delete settings().baselineQuery; delete settings().baselineWeight;   // removed feature — drop orphaned stored values
    await setLanguage(settings().language, { fetchPack, store: packStore });
    // The one place wordBoundary crosses into the matcher, which holds it module-level; re-pushed by the select's handler below.
    matcher.setBoundaryMode(settings().wordBoundary);

    $('#extensions_settings').append(SETTINGS_HTML);

    updateEmbedInfo();   // refresh on drawer open so it tracks Vector Storage changes made mid-session
    $('#wa_embed_info').closest('.inline-drawer').children('.inline-drawer-toggle').on('click', updateEmbedInfo);

    $('#extensionsMenu').append('<div id="wa_studio" class="list-group-item flex-container flexGap5" title="Worlds Apart — Lorebook Studio: manage all lorebooks and entries"><div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>WA Lorebook Studio</span></div>');
    $('#wa_studio').on('click', () => { lorebookStudio(chatBook()); });

    bind('#wa_enabled', 'enabled', 'checked');
    // ensureStudioStyle styles the sort widget; the Studio injects it lazily and this control can be used first (idempotent).
    ensureStudioStyle();
    const getTierCfg = () => reconcileTiers(settings().tierCfg);
    const setTierCfg = cfg => { settings().tierCfg = cfg; saveSettingsDebounced(); };
    const presentationMount = document.querySelector('#wa_presentation_order_mount');
    const tierMount = document.querySelector('#wa_tier_editor_mount');
    let tierEditor = null;
    if (presentationMount) presentationMount.append(makeSortControl({
        getSort: () => normPresentation(settings().presentationOrder),
        setSort: k => { settings().presentationOrder = k; saveSettingsDebounced(); },
        getTiered: () => !!settings().presentationTiered,
        setTiered: on => { settings().presentationTiered = on; saveSettingsDebounced(); },
        getTierCfg, setTierCfg,
        extraItems: [{ label: 'Most relevant first', key: 'best-first' }, { label: 'Most relevant last', key: 'best-last' }],
        // Keeps the inline tier editor in sync when tiers are reordered from the button's menu.
        onChange: () => { if (tierEditor) tierEditor.replaceWith(tierEditor = makeTierEditor(getTierCfg, setTierCfg, () => {})); },
        block: true,
    }));
    if (tierMount) tierMount.append(tierEditor = makeTierEditor(getTierCfg, setTierCfg, () => {}));
    renderPluginSetup();                     // paints "checking…" then the detected/install state
    Promise.all([hasPlugin(), computeSourceFingerprint()]).then(() => {
        renderPluginSetup();
        // The settings banner only shows once somebody opens settings, and a drifted plugin answers with stale code meanwhile.
        if (pluginDrifted()) toastr.warning('Server plugin is out of date. Redeploy it and restart SillyTavern.', 'Worlds Apart', { timeOut: 0, extendedTimeOut: 0 });
    });
    bind('#wa_debug_log', 'debugLog', 'checked');
    document.querySelector('#wa_find_orphans')?.addEventListener('click', async () => {
        const out = document.querySelector('#wa_orphans_out');
        if (out) out.textContent = 'Looking…';
        try { const line = await reportOrphanCollections(); if (out) out.textContent = line; }
        catch (error) { if (out) out.textContent = `Failed: ${error.message}`; }
    });
    $('#wa_rater_id').val(settings().raterId);
    bind('#wa_message_depth', 'messageDepth', 'number');
    bind('#wa_match_window', 'matchWindow', 'string');
    bind('#wa_language', 'language', 'string');
    const languageState = () => {
        const t = table();
        $('#wa_language_state').text(t.loaded ? `${t.label} — ${t.zipf.size} words` : `${t.lang}: pack not loaded — every word reads rare until it is`);
    };
    $('#wa_language').on('change', async () => { await setLanguage(settings().language, { fetchPack, store: packStore }); languageState(); });
    // The index is read only here, when the panel fills its list; a stored pack the index has moved is refreshed then.
    (async () => {
        const index = await refreshIndex({ fetchIndex, fetchPack, store: packStore });
        const $sel = $('#wa_language');
        const known = new Set(['en']);
        for (const [lang, meta] of Object.entries(index ?? {})) { if (!known.has(lang)) { known.add(lang); $sel.append(new Option(meta.label, lang)); } }
        // A language the store holds but the index no longer lists stays selectable while it is the setting.
        if (!known.has(settings().language)) $sel.append(new Option(settings().language, settings().language));
        $sel.val(settings().language);
        languageState();
    })();
    bind('#wa_drop_chat_tags', 'dropChatTags', 'string');
    bind('#wa_word_boundary', 'wordBoundary', 'string');
    $('#wa_word_boundary').on('change', () => matcher.setBoundaryMode(settings().wordBoundary));
    bind('#wa_llm_profile', 'llmProfile', 'string');
    bind('#wa_llm_temp', 'llmTemperature', 'string');
    bind('#wa_max_entries', 'maxVectorEntries', 'number');
    bind('#wa_max_tokens', 'maxTokens', 'number');
    bind('#wa_max_tokens_pct', 'maxTokensPercent', 'number');
    bind('#wa_budget_slack', 'budgetSlackPercent', 'number');
    bind('#wa_slack_mode', 'budgetSlackMode', 'string');
    bind('#wa_relevance_cutoff', 'relevanceCutoff', 'number');
    bind('#wa_max_dynamic', 'maxDynamicEntries', 'number');
    bind('#wa_max_total', 'maxTotalEntries', 'number');
    bind('#wa_drop_unavailable', 'dropUnavailable', 'checked');
    bind('#wa_tokens_include_exempt', 'maxTokensIncludesExempt', 'checked');

    bind('#wa_world_priority_mode', 'worldPriorityMode', 'string');
    $('#wa_world_priority_mode').on('change', renderWorldPriority);
    const $wp = $('#wa_world_priority_list');
    const editField = (field, el) => {
        const l = charPriority();
        if (!l) return;
        l[$(el).closest('.wa-world-row').data('i')][field] = Number($(el).val());
        saveSettingsDebounced();
    };
    $wp.on('input change', '.wa-world-weight', function () { editField('weight', this); });
    $wp.on('input change', '.wa-world-offset', function () { editField('offset', this); });
    $wp.on('input change', '.wa-world-cap', function () { editField('cap', this); });
    // Swap with the adjacent VISIBLE row, not the array neighbour: a filtered-out book between them must not absorb the move.
    const moveWorld = (i, dir) => {
        const scoped = scopedPriority();
        if (!scoped) return;
        const p = scoped.findIndex(x => x.i === i);
        const target = scoped[p + dir];
        if (!target) return;
        const l = charPriority();
        [l[i], l[target.i]] = [l[target.i], l[i]];
        saveSettingsDebounced();
        renderWorldPriority();
    };
    $wp.on('click', '.wa-world-up', function () { moveWorld($(this).closest('.wa-world-row').data('i'), -1); });
    $wp.on('click', '.wa-world-down', function () { moveWorld($(this).closest('.wa-world-row').data('i'), 1); });
    renderWorldPriority();

    // After bind(), so the dropdown's value survives being rebuilt.
    populateProfiles();
    $('#wa_refresh_profiles').on('click', () => populateProfiles(true));
    $('#wa_review_bundles').on('click', () => superEvalScene());

    eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => { runState.generationIsDryRun = Boolean(dryRun); });
    eventSource.on(event_types.GENERATION_ENDED, () => { runState.generationIsDryRun = false; runState.waOwnsScan = false; });

    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);

    // WORLDINFO_ENTRIES_LOADED only fires during a scan, so CHAT_CHANGED refreshes the attached-book set.
    const refreshAttached = () => getSortedEntries().then(showExemptCount).catch(() => {});
    eventSource.on(event_types.CHAT_CHANGED, refreshAttached);
    // Wrapped, not passed by reference: CHAT_CHANGED emits the chat id, which would land in resetSmartKeys's `scope`.
    eventSource.on(event_types.CHAT_CHANGED, () => resetSmartKeys());
    // The panel survives dry-run scans untouched, so it would carry the previous chat's selection across a switch.
    eventSource.on(event_types.CHAT_CHANGED, () => { runState.lastPromptOrder = []; renderDeliveryPanel([]); });
    refreshAttached();
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScanDone);
    // After onScanDone, so the feed sees the flag while the scan is live. Cleared on the final loop, not only at
    // GENERATION_ENDED, so a between-scans getSortedEntries escapes the blanking.
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, (args) => {
        if (!args?.state?.next) runState.waOwnsScan = false;
    });

    if (settings().enabled) renderDeliveryPanel(runState.lastPromptOrder);

    /** Registers a command under its name plus the `wa=` twin of it, keeping any aliases the props already carry. */
    const addWaCommand = props => SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        ...props,
        aliases: [...(props.aliases ?? []), props.name.replace(/^wa-/, 'wa=')],
    }));

    addWaCommand({
        name: 'wa-versus',
        callback: async (named) => { await versusCore(named); return ''; },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'how many of WA\u2019s ranked entries to carry beyond the two delivered sets, for grading depth', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '30' }),
        ],
        helpString: 'Worlds Apart: what WA delivered on this turn against what ST core + Vector Storage would have, at their own budgets. Runs /wa-debug first, prints the difference, and downloads an ordinary two-arm capture bundle \u2014 grade it with Review bundles, apply with eval/synthetic-data/apply-review.mjs, then score with eval/versus-score.mjs.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-core',
        callback: () => {
            const c = runState.lastCoreSet;
            if (!c) { toastr.info('No core selection recorded yet — it is captured on ST\u2019s own dry runs, so send or receive a message first.', 'Worlds Apart'); return ''; }
            console.log(`%cWorlds Apart \u00b7 ST core's own selection at message ${c.at} \u2014 ${c.entries.length} entries, core budget ${c.budget ?? 'unknown'}`, 'font-weight: bold');
            console.table(c.entries.map(e => ({ uid: e.uid, order: e.order, constant: e.constant, book: e.world, entry: e.title })));
            console.log(`uids for eval/core-compare.mjs --core-uids:\n${c.entries.map(e => e.uid).join(',')}`);
            toastr.success(`${c.entries.length} entries \u2014 see console`, 'ST core selection');
            return '';
        },
        helpString: 'Worlds Apart: what ST core selected on its own, with WA standing down. Captured from ST\u2019s dry runs, where interceptors are skipped and core runs its own budget \u2014 so it is core\u2019s shipped set, keyword route only. Console.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-dry',
        callback: () => dryRun(false),
        helpString: 'Worlds Apart: run retrieval and a World Info scan without generating. Reports the settings used and what got selected, in prompt order. Console.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-debug',
        callback: () => dryRun(true),
        helpString: 'Worlds Apart: same as /wa-dry plus every intermediate — query text, surviving term weights, per-signal scores, and the full vector-candidate ranking past the cut. Console.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-grade',
        callback: gradeScene,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: 'sample name, used as the filename', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'scene-<date>' }),
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'how many retrieved entries to surface for grading (the cliff is switched off for the run, so the sample can assess every cutoff mode offline)', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '20' }),
            SlashCommandNamedArgument.fromProps({ name: 'notes', description: 'free-text note stored in the sample', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'Worlds Apart: grade this scene for the offline evals. Runs /wa-debug, then opens a window listing every activated entry with the query text and per-signal scores, for grading 0-5 (constants and stickies are listed but not graded — relevance never chose them). Saving downloads a self-contained sample: query text, settings snapshot, candidate ranking, grades, and copies of every attached lorebook, so later chat/lorebook/settings edits cannot move the numbers. Drop it in eval/eval-data/ and run eval/graded-scene-grid.mjs --sample.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-super-grade',
        callback: superGradeScene,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: 'base sample name; each arm gets "<name>--<arm>.json"', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'chat-msgN' }),
            SlashCommandNamedArgument.fromProps({ name: 'arms', description: 'which arms to capture, comma-separated (default: all)', typeList: [ARGUMENT_TYPE.STRING], enumList: Object.keys(POOL_ARMS) }),
            SlashCommandNamedArgument.fromProps({ name: 'candidates', description: 'candidate depth per arm (the cliff is switched off for each run)', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '30' }),
            SlashCommandNamedArgument.fromProps({ name: 'notes', description: 'free-text note stored in every sample written', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'Worlds Apart: grade this scene against SEVERAL configurations at once, for a pool that isn\'t biased toward the current defaults. Runs /wa-debug once per arm (arms change which entries get surfaced — entity filter, retrieval mode, threshold, key suppression, summary queries), unions the entries they surfaced, dedupes, and opens one grading window over the union with a "surfaced by" column. Load earlier rounds\' samples into the file picker and their grades are subtracted, so each round only judges what is new. Saves one sample per arm — each with its own params and candidate rows, all sharing the pooled grades. Drop them in eval/eval-data/, run eval/graded-scene-grid.mjs --sample on each, and add arms until the judged@10 column stops showing gaps.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-super-eval',
        callback: superEvalScene,
        helpString: 'Worlds Apart: review graded samples/bundles from their FILES, chat-independent — nothing live is read, so scenes captured offline or graded by an LLM judge open without loading their chat. Pick several and each becomes a section with its own query text; stored grades arrive pre-filled and editable, entry text comes from the embedded books. Save downloads ONE review file for the whole run; apply it with node eval/synthetic-data/apply-review.mjs <file> --write.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-studio',
        // Wrapped: ST hands callbacks (namedArgs, unnamedArgs), which would land in preferredBook.
        callback: () => lorebookStudio(chatBook()),
        helpString: 'Worlds Apart: open Lorebook Studio — a wide two-pane manager listing every lorebook on the left and the selected book\'s entries on the right. Per-entry tools (mode, flags, sticky, ⚡/✨ keyword suggestions, prune-scan colouring, duplicate/delete), a Tool Settings drawer, bulk selection + actions (enable/disable, mode, sticky, trigger %, renumber, delete), and book tools (rename, duplicate, delete, type filter, suggest-all). Also on the extensions (wand) menu.',
        returns: 'nothing',
    });

    addWaCommand({
        name: 'wa-query',
        callback: probeQuery,
        helpString: 'Worlds Apart: score entries against arbitrary text without activating anything. Usage: /wa-query your query text here',
        returns: 'nothing',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'query text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
    });

    console.log('Worlds Apart: ready');
}

globalThis.worldsApart_intercept = intercept;

// `hooks.activate` may not fire on every ST version; the jQuery bootstrap is the fallback.
jQuery(async () => {
    await init();
});
