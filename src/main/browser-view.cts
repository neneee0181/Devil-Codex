import type { WebContents } from "electron";

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

// The embedded browser is a renderer-side <webview> (a real Chromium guest) so
// that DOM modals/popovers can layer above it (a native WebContentsView would
// always paint on top). This manager holds the guest's WebContents — captured
// via the host's did-attach-webview — so both the user and (later) AI control
// run through one path, and so step 2 can attach CDP to it.
export class BrowserViewManager {
  private wc: WebContents | undefined;
  private pendingUrl = "";

  constructor(private readonly send: (channel: string, payload: unknown) => void) {}

  // Ask the renderer to open/focus the browser tab so the user sees AI actions.
  requestActivate(): void { this.send("browser:activate", {}); }

  attach(wc: WebContents): void {
    this.wc = wc;
    if (this.pendingUrl) { const url = this.pendingUrl; this.pendingUrl = ""; void wc.loadURL(url).catch(() => undefined); }
    const emit = (): void => this.send("browser:state", this.state());
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);
    wc.on("page-title-updated", emit);
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("did-finish-load", emit);
    wc.setWindowOpenHandler(({ url }) => { void wc.loadURL(normalizeUrl(url)).catch(() => undefined); return { action: "deny" }; });
    wc.on("destroyed", () => { if (this.wc === wc) this.wc = undefined; });
  }

  state(): BrowserState {
    const wc = this.wc;
    return {
      url: wc?.getURL() ?? "",
      title: wc?.getTitle() ?? "",
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    };
  }

  navigate(rawUrl: string): void {
    const url = normalizeUrl(rawUrl);
    // No webview yet (browser tab not open): queue it; attach() loads it once the
    // renderer mounts the <webview> in response to the activate request.
    if (!this.wc) { this.pendingUrl = url; return; }
    void this.wc.loadURL(url).catch(() => undefined);
  }

  // Wait until the queued/started navigation finishes loading (the tab must open
  // and attach first), so callers (the MCP) get the real page title back.
  async waitForLoad(timeoutMs = 10000): Promise<BrowserState> {
    const start = Date.now();
    for (;;) {
      const wc = this.wc;
      if (wc && !this.pendingUrl && wc.getURL() && !wc.isLoading()) return this.state();
      if (Date.now() - start > timeoutMs) return this.state();
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  goBack(): void { if (this.wc?.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack(); }
  goForward(): void { if (this.wc?.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward(); }
  reload(): void { this.wc?.reload(); }
  hardReload(): void { this.wc?.reloadIgnoringCache(); }
  stop(): void { this.wc?.stop(); }

  async screenshot(): Promise<string> {
    if (!this.wc) return "";
    let image = await this.wc.capturePage();
    if (image.isEmpty()) return "";
    // capturePage returns device pixels (retina = 2x). Resize to the CSS viewport
    // so coordinates the model reads off the image match sendInputEvent (CSS px);
    // otherwise clicks land at 2x offset (e.g. hitting the wrong element).
    const css = await this.wc.executeJavaScript("({w:Math.round(innerWidth),h:Math.round(innerHeight)})").catch(() => null) as { w: number; h: number } | null;
    if (css && css.w > 0) image = image.resize({ width: css.w, height: css.h });
    return image.toDataURL();
  }

  find(text: string, options?: { forward?: boolean; findNext?: boolean }): void {
    if (!this.wc || !text) return;
    this.wc.findInPage(text, options);
  }
  stopFind(): void { this.wc?.stopFindInPage("clearSelection"); }

  setZoom(factor: number): number {
    if (!this.wc) return 1;
    const clamped = Math.min(Math.max(factor, 0.25), 3);
    this.wc.setZoomFactor(clamped);
    return clamped;
  }
  getZoom(): number { return this.wc?.getZoomFactor() ?? 1; }

  async clearCookies(): Promise<void> { await this.wc?.session.clearStorageData({ storages: ["cookies"] }); }
  async clearCache(): Promise<void> { await this.wc?.session.clearCache(); }

  // Crop a screenshot to a page rect (CSS px, viewport-relative) for the element
  // picker. The picker JS runs renderer-side on the <webview>; this just captures.
  async captureRect(rect: { x: number; y: number; width: number; height: number }): Promise<string> {
    if (!this.wc) return "";
    const valid = rect.width > 1 && rect.height > 1;
    const image = await this.wc.capturePage(valid ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined).catch(() => undefined);
    return image && !image.isEmpty() ? image.toDataURL() : "";
  }

  // ---- AI control (step 2): real input events on the guest + a visible cursor
  // so the user can watch the agent move/click/type, like stock Codex. ----

  private async ensureCursor(): Promise<void> {
    if (!this.wc) return;
    await this.wc.executeJavaScript(CURSOR_SCRIPT, true).catch(() => undefined);
  }

  private delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  private async rectOf(selector: string): Promise<{ x: number; y: number } | null> {
    if (!this.wc) return null;
    const js = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`;
    return this.wc.executeJavaScript(js).catch(() => null) as Promise<{ x: number; y: number } | null>;
  }

  async aiClick(target: { x?: number; y?: number; selector?: string }): Promise<boolean> {
    if (!this.wc) return false;
    let pt: { x: number; y: number } | null = typeof target.x === "number" && typeof target.y === "number" ? { x: target.x, y: target.y } : null;
    if (!pt && target.selector) pt = await this.rectOf(target.selector);
    if (!pt) return false;
    const { x, y } = pt;
    await this.ensureCursor();
    await this.wc.executeJavaScript(`window.__devilCursor&&window.__devilCursor.moveTo(${x},${y})`).catch(() => undefined);
    await this.delay(440);
    await this.wc.executeJavaScript(`window.__devilCursor&&window.__devilCursor.clickAt(${x},${y})`).catch(() => undefined);
    this.wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
    this.wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    this.wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    return true;
  }

  async aiType(text: string): Promise<void> {
    if (!this.wc) return;
    // Set the value directly on the focused field: char events don't compose
    // multibyte (Korean) text and miss React-controlled inputs. Use the native
    // value setter + input/change so frameworks pick it up; fall back to chars.
    const js = `(function(t){var el=document.activeElement;if(!el)return false;`
      + `if('value' in el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA')){`
      + `var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;`
      + `var d=Object.getOwnPropertyDescriptor(proto,'value');var nv=(el.value||'')+t;`
      + `try{d&&d.set?d.set.call(el,nv):el.value=nv;}catch(e){el.value=nv;}`
      + `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}`
      + `if(el.isContentEditable){el.textContent=(el.textContent||'')+t;el.dispatchEvent(new Event('input',{bubbles:true}));return true;}return false;})(${JSON.stringify(text)})`;
    const ok = await this.wc.executeJavaScript(js).catch(() => false);
    if (!ok) { for (const ch of text) { this.wc.sendInputEvent({ type: "char", keyCode: ch }); await this.delay(12); } }
  }

  async aiKey(key: string): Promise<void> {
    if (!this.wc) return;
    // Dispatch a real keyboard event (Enter-to-submit, Tab, etc.) on the focused
    // element, and submit the form on Enter; plus the native input event.
    const keyCode = key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0;
    const js = `(function(k,kc){var el=document.activeElement||document.body;`
      + `['keydown','keypress','keyup'].forEach(function(t){el.dispatchEvent(new KeyboardEvent(t,{key:k,code:k,keyCode:kc,which:kc,bubbles:true,cancelable:true}));});`
      + `if(k==='Enter'&&el&&el.form){try{el.form.requestSubmit?el.form.requestSubmit():el.form.submit();}catch(e){}}return true;})(${JSON.stringify(key)},${keyCode})`;
    await this.wc.executeJavaScript(js).catch(() => undefined);
    this.wc.sendInputEvent({ type: "keyDown", keyCode: key });
    this.wc.sendInputEvent({ type: "keyUp", keyCode: key });
  }

  async aiScroll(dy: number): Promise<void> {
    await this.wc?.executeJavaScript(`window.scrollBy(0, ${Math.round(dy)})`).catch(() => undefined);
  }

  async aiReadText(): Promise<string> {
    if (!this.wc) return "";
    const text = await this.wc.executeJavaScript("document.body?document.body.innerText:''").catch(() => "") as string;
    const body = (text || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 7000);
    // Also list interactive elements with a stable selector so non-vision models
    // can click precisely (browser_click selector=...) instead of guessing x,y.
    const els = await this.wc.executeJavaScript(INTERACTIVE_SCRIPT).catch(() => "") as string;
    return els ? `${body}\n\n[조작 가능 요소 — browser_click selector=로 사용]\n${els}` : body;
  }
}

// Lists visible inputs/buttons/links with a stable CSS selector + label so a
// model without vision can target them precisely.
const INTERACTIVE_SCRIPT = `(function(){
  function sel(el){ if(el.id) return (el.tagName.toLowerCase()+'#'+CSS.escape(el.id)); var n=el.getAttribute('name'); if(n) return el.tagName.toLowerCase()+'[name="'+n+'"]'; var c=(el.className&&typeof el.className==='string')?'.'+el.className.trim().split(/\\s+/).slice(0,2).map(function(x){return CSS.escape(x)}).join('.'):''; return el.tagName.toLowerCase()+c; }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>2&&r.height>2&&r.top<window.innerHeight&&r.bottom>0; }
  var out=[]; var seen={};
  document.querySelectorAll('input,textarea,button,a[href],[role=button],select').forEach(function(el){
    if(out.length>=40||!vis(el))return;
    var label=(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.value||el.innerText||el.getAttribute('title')||'').trim().replace(/\\s+/g,' ').slice(0,40);
    var s=sel(el); var key=s+'|'+label; if(seen[key])return; seen[key]=1;
    out.push(s+(label?(' — "'+label+'"'):''));
  });
  return out.join('\\n');
})()`;

// Injected once into the guest page: a visible AI cursor that glides to targets
// and shows a click ripple. Re-injected before each action (page loads wipe it).
const CURSOR_SCRIPT = `(function(){
  if(window.__devilCursor&&document.getElementById('__devil_cursor__'))return;
  var c=document.getElementById('__devil_cursor__');
  if(!c){c=document.createElement('div');c.id='__devil_cursor__';
    c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;width:40px;height:40px;pointer-events:none;transition:transform .45s cubic-bezier(.22,1,.36,1);transform:translate(-200px,-200px);will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.5));';
    c.innerHTML='<svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M5 3l14 8-6 1.5L9.5 19 5 3z" fill="#e0294f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    (document.body||document.documentElement).appendChild(c);}
  window.__devilCursor={
    moveTo:function(x,y){c.style.transform='translate('+x+'px,'+y+'px)';},
    clickAt:function(x,y){var r=document.createElement('div');r.style.cssText='position:fixed;left:'+x+'px;top:'+y+'px;z-index:2147483646;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:3px solid #e0294f;background:rgba(224,41,79,.35);pointer-events:none;animation:__devilRipple .55s ease-out forwards;';document.body.appendChild(r);setTimeout(function(){try{r.remove()}catch(e){}},580);}
  };
  if(!document.getElementById('__devil_cursor_style__')){var s=document.createElement('style');s.id='__devil_cursor_style__';s.textContent='@keyframes __devilRipple{from{transform:scale(.6);opacity:.9}to{transform:scale(2.6);opacity:0}}';document.head.appendChild(s);}
})();`;

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) return "about:blank";
  if (/^about:blank$/i.test(value)) return "about:blank";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  if (/\s/.test(value) || !/\.[a-z]{2,}/i.test(value)) return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  return `https://${value}`;
}
