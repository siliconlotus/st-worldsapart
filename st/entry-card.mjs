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
    head.append(p.selBox, p.mode, p.onOff, titleWrap, ...(p.badge ? [p.badge] : []), ...(p.open ? [p.moreBtn] : []), p.chev);
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
    // Secondary keys: a fold while the entry has none, the tray itself once it has.
    if (p.secFold) body.append(p.secFold); else body.append(p.sec);
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
