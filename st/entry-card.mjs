// entry-card.mjs — the phone arrangement of one Studio entry: a title bar, then preview, keys, folds and the tray.
import { t } from '../../../../i18n.js';

/** Lays the parts renderEntry built out as the card; the row arrangement is renderEntry's own. */
export function arrangeCard(p) {
    const { row, head } = p;
    head.classList.add('wa-card-bar');
    const titleWrap = document.createElement('span'); titleWrap.className = 'wa-entry-titlewrap';
    const titleLine = document.createElement('span'); titleLine.className = 'wa-entry-titleline';
    titleLine.append(p.title, ...(p.dupMark ? [p.dupMark] : []), p.pencil);
    titleWrap.append(titleLine);
    head.append(p.selBox, p.mode, p.onOff, titleWrap, ...(p.badge && !p.open ? [p.badge] : []), ...(p.open ? [p.moreBtn] : []), p.chev);
    row.append(head);
    if (!p.open) return row;

    const body = document.createElement('div'); body.className = 'wa-entry-body wa-card-body';
    // Preview: the text clamped to four lines; the whole block opens the editor popup.
    const pv = document.createElement('div'); pv.className = 'wa-card-preview';
    const txt = document.createElement('div'); txt.className = 'wa-card-preview-text'; txt.textContent = p.previewText || t`(empty)`;
    const pen = document.createElement('i'); pen.className = 'fa-solid fa-pencil wa-card-preview-pen';
    pv.title = t`Tap to edit the text`;
    pv.append(txt, pen);
    pv.addEventListener('click', p.onPreviewTap);
    body.append(pv, p.chips);
    body.append(p.secFold);
    const sugg = document.createElement('div'); sugg.className = 'wa-kw-para'; sugg.append(...p.suggItems);
    body.append(p.suggFold(sugg));
    const adv = document.createElement('details'); adv.className = 'wa-fold wa-fold-adv'; adv.open = p.advOpen;
    const sum = document.createElement('summary'); sum.textContent = t`Advanced`;
    if (p.advSummaryParts.length) { const s = document.createElement('span'); s.className = 'wa-fold-sub'; s.textContent = p.advSummaryParts.join(' · '); sum.append(s); }
    adv.append(sum);
    if (p.advOpen && p.tray) adv.append(p.tray);
    adv.addEventListener('toggle', () => p.onAdvToggle(adv.open));
    body.append(adv);
    row.append(body);
    return row;
}

/** The phone header: a book select in place of the nav pane, the search box, then filter, sort and one menu for the rail and the book tools. */
export function buildPhoneHeader({ books, selected, attached, orphans, onPick, search, filterBtn, sortBtn, menuItems, openMenu }) {
    const head = document.createElement('div'); head.className = 'wa-phone-head';
    const sel = document.createElement('select'); sel.className = 'text_pole wa-book-select';
    if (!selected) sel.append(Object.assign(new Option(t`Select a lorebook…`, ''), { disabled: true, selected: true }));
    const att = books.filter(b => attached.has(b)), rest = books.filter(b => !attached.has(b));
    for (const b of att) sel.append(new Option(`● ${b}`, b));
    for (const b of rest) sel.append(new Option(b, b));
    if (orphans) sel.append(new Option(t`Orphaned bindings (${orphans})`, '\u001Forphans'));
    if (selected) sel.value = selected;
    sel.addEventListener('change', () => { if (sel.value) onPick(sel.value); });
    const row3 = document.createElement('div'); row3.className = 'wa-phone-row';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'menu_button wa-phone-menu'; more.innerHTML = '<i class="fa-solid fa-ellipsis"></i>'; more.title = t`Lorebook and tools menu`;
    more.addEventListener('click', () => { const r = more.getBoundingClientRect(); openMenu(menuItems(), r.right - 180, r.bottom + 2); });
    row3.append(filterBtn, sortBtn, more);
    head.append(sel);
    if (selected) head.append(search, row3);   // with no book open, every control below acts on `selected`
    return head;
}
