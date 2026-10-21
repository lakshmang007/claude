import { previewUrl } from '../api';
import type { PadDoc } from '../pad';
import { debounce, h, icon } from '../util';

/**
 * Live preview beside the editor: Markdown rendered (and sanitised) in the page, HTML in a
 * sandboxed frame served from the pad itself, so its relative links reach attached files.
 */
export class PreviewPane {
  readonly el: HTMLElement;
  #body: HTMLElement;
  #title: HTMLElement;
  #openLink: HTMLAnchorElement;
  #doc: PadDoc | null = null;
  #mode: 'markdown' | 'html' | null = null;
  #frame: HTMLIFrameElement | null = null;
  #unobserve: (() => void) | null = null;
  #version = 0;

  constructor(onClose: () => void) {
    this.#title = h('span.preview-title');
    this.#openLink = h('a.icon-btn.small', { target: '_blank', rel: 'noopener', title: 'Open the page in a new tab', 'aria-label': 'Open in new tab' }, icon('link', 14)) as HTMLAnchorElement;
    const close = h('button.icon-btn.small', { type: 'button', title: 'Close preview', 'aria-label': 'Close preview' }, icon('x', 14));
    close.addEventListener('click', onClose);
    this.#body = h('div.preview-body');
    this.el = h('section.preview-pane', { 'aria-label': 'Preview' }, h('div.preview-head', null, this.#title, h('span.spacer'), this.#openLink, close), this.#body);
  }

  get mode(): 'markdown' | 'html' | null {
    return this.#mode;
  }

  show(doc: PadDoc, mode: 'markdown' | 'html'): void {
    if (this.#doc === doc && this.#mode === mode) return;
    this.hide();
    this.#doc = doc;
    this.#mode = mode;
    this.#title.textContent = mode === 'html' ? 'Page preview' : 'Markdown preview';
    this.#openLink.hidden = mode !== 'html';
    if (mode === 'html') {
      this.#frame = h('iframe.preview-frame', {
        title: 'Page preview',
        sandbox: 'allow-scripts allow-forms allow-modals allow-popups',
        referrerpolicy: 'no-referrer',
      }) as HTMLIFrameElement;
      this.#body.replaceChildren(this.#frame);
    } else {
      this.#body.replaceChildren(h('article.markdown-body'));
    }
    const update = debounce(() => this.#render(), mode === 'html' ? 700 : 150);
    const onChange = () => update();
    doc.text.observe(onChange);
    this.#unobserve = () => {
      update.cancel();
      doc.text.unobserve(onChange);
    };
    // The server needs a moment to receive the first sync before the frame asks for it.
    setTimeout(() => this.#render(), mode === 'html' ? 300 : 0);
  }

  hide(): void {
    this.#unobserve?.();
    this.#unobserve = null;
    this.#doc = null;
    this.#mode = null;
    this.#frame = null;
    this.#body.replaceChildren();
  }

  async #render(): Promise<void> {
    const doc = this.#doc;
    if (!doc) return;
    if (this.#mode === 'html' && this.#frame) {
      const url = `${previewUrl(doc.path)}?v=${++this.#version}`;
      this.#frame.src = url;
      this.#openLink.href = previewUrl(doc.path);
      return;
    }
    const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
    if (this.#doc !== doc) return;
    const html = await marked.parse(doc.text.toString(), { gfm: true, breaks: false });
    const article = this.#body.firstElementChild as HTMLElement;
    article.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    for (const a of article.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
}
