import './style.css';
import { pipeline, env } from '@huggingface/transformers';

// Runtime policy: models must come from this site's /models directory.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = true;
env.useWasmCache = true;

const app = document.querySelector('#app');
const state = { direction: 'ar-fr', translator: null, loadedFor: null, busy: false };

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">OFFLINE • ON-DEVICE</p>
        <h1>المترجم العربي الفرنسي</h1>
        <p class="subtitle">ترجمة محلية داخل المتصفح دون API أو حساب أو إعلانات.</p>
      </div>
      <button id="settingsBtn" class="icon-btn" aria-label="الإعدادات" title="الإعدادات">⚙</button>
    </header>

    <section class="card">
      <div class="direction-row">
        <button id="fromLang" class="lang-pill active">العربية</button>
        <button id="swapBtn" class="swap-btn" aria-label="تبديل الاتجاه" title="تبديل الاتجاه">⇄</button>
        <button id="toLang" class="lang-pill">الفرنسية</button>
      </div>

      <div class="editor-grid">
        <section class="panel">
          <div class="panel-head"><span>النص</span><button id="clearBtn" class="mini-btn">مسح</button></div>
          <textarea id="input" dir="auto" spellcheck="false" placeholder="اكتب بالعربية…"></textarea>
          <div class="count" id="count">0 حرف</div>
        </section>
        <section class="panel output-panel">
          <div class="panel-head"><span>الترجمة</span><button id="copyBtn" class="mini-btn">نسخ</button></div>
          <div id="output" class="output" dir="auto">ستظهر الترجمة هنا.</div>
          <div class="progress-wrap"><div id="progress" class="progress"></div></div>
        </section>
      </div>

      <button id="translateBtn" class="translate-btn">ترجمة</button>
      <p id="status" class="status">سيتم تحميل النموذج المطلوب من ملفات الموقع أول مرة.</p>
    </section>

    <section class="privacy-card">
      <div class="privacy-icon">✓</div>
      <div>
        <strong>خصوصيتك أولًا</strong>
        <p>بعد تجهيز النموذج وتخزينه محليًا، يمكن إيقاف الإنترنت. الترجمة نفسها لا تستخدم أي API ولا ترسل النص إلى خادم.</p>
      </div>
    </section>

    <dialog id="settingsDialog">
      <div class="dialog-head"><h2>الإعدادات</h2><button id="closeSettings" class="mini-btn">إغلاق</button></div>
      <div class="setting"><strong>التنفيذ</strong><span>داخل المتصفح</span></div>
      <div class="setting"><strong>النماذج</strong><span id="modelState">OPUS-MT</span></div>
      <div class="setting"><strong>النصوص</strong><span>لا تُحفظ تلقائيًا</span></div>
      <p class="note">التطبيق يمنع النماذج البعيدة وقت الترجمة. يجب تجهيز مجلدي <code>/models/ar-fr</code> و<code>/models/fr-ar</code> أثناء النشر.</p>
    </dialog>
  </main>
`;

const $ = id => document.getElementById(id);

function renderDirection() {
  const ar = state.direction === 'ar-fr';
  $('fromLang').textContent = ar ? 'العربية' : 'الفرنسية';
  $('toLang').textContent = ar ? 'الفرنسية' : 'العربية';
  $('input').placeholder = ar ? 'اكتب بالعربية…' : 'Écrivez en français…';
}

function splitLongText(text, limit = 380) {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const chunks = [];
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) { chunks.push(''); continue; }
    const sentences = paragraph.match(/[^.!؟?…]+(?:[.!؟?…]+|$)/g) || [paragraph];
    let current = '';
    for (const sentence of sentences) {
      const clean = sentence.trim();
      if (!clean) continue;
      const next = current ? `${current} ${clean}` : clean;
      if (next.length > limit && current) {
        chunks.push(current);
        current = clean;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

async function loadTranslator() {
  if (state.translator && state.loadedFor === state.direction) return state.translator;
  const model = state.direction;
  $('status').textContent = `جارٍ تجهيز نموذج ${model === 'ar-fr' ? 'العربية → الفرنسية' : 'الفرنسية → العربية'} محليًا…`;
  $('progress').style.width = '8%';

  try {
    state.translator = await pipeline('translation', `/models/${model}`, {
      device: 'wasm',
      progress_callback: (p) => {
        if (typeof p?.progress === 'number') {
          const pct = Math.max(8, Math.min(88, Math.round(p.progress * 80)));
          $('progress').style.width = `${pct}%`;
        }
      },
    });
    state.loadedFor = model;
    $('modelState').textContent = `OPUS-MT ${model}`;
    $('progress').style.width = '100%';
    $('status').textContent = 'النموذج محمّل محليًا وجاهز.';
    return state.translator;
  } catch (error) {
    console.error(error);
    $('progress').style.width = '0%';
    $('status').textContent = 'تعذر تشغيل النموذج المحلي. تأكد من نشر ملفات النموذج داخل /models/' + model + '. لم يتم إرسال النص إلى الإنترنت.';
    throw error;
  }
}

async function translate() {
  if (state.busy) return;
  const text = $('input').value.trim();
  if (!text) {
    $('output').textContent = 'أدخل نصًا أولًا.';
    return;
  }

  state.busy = true;
  $('translateBtn').disabled = true;
  $('progress').style.width = '5%';
  $('status').textContent = 'جارٍ تنفيذ الترجمة على الجهاز…';

  try {
    const translator = await loadTranslator();
    const parts = splitLongText(text);
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) {
        results.push('');
        continue;
      }
      const result = await translator(parts[i], {
        max_new_tokens: 256,
        num_beams: 4,
        return_full_text: false,
      });
      results.push(result?.[0]?.translation_text ?? '');
      $('progress').style.width = `${20 + Math.round(((i + 1) / parts.length) * 80)}%`;
    }
    $('output').textContent = results.join('\n\n');
    $('status').textContent = 'تمت الترجمة محليًا. يمكنك الآن فصل الإنترنت.';
  } catch (_) {
    // User-facing status is set by loadTranslator().
  } finally {
    state.busy = false;
    $('translateBtn').disabled = false;
  }
}

$('swapBtn').onclick = () => {
  state.direction = state.direction === 'ar-fr' ? 'fr-ar' : 'ar-fr';
  state.translator = null;
  state.loadedFor = null;
  renderDirection();
  $('output').textContent = 'ستظهر الترجمة هنا.';
  $('progress').style.width = '0%';
  $('status').textContent = 'تم تبديل الاتجاه.';
};

$('clearBtn').onclick = () => {
  $('input').value = '';
  $('output').textContent = 'ستظهر الترجمة هنا.';
  $('count').textContent = '0 حرف';
};

$('copyBtn').onclick = async () => {
  const value = $('output').textContent.trim();
  if (!value || value === 'ستظهر الترجمة هنا.') return;
  try {
    await navigator.clipboard.writeText(value);
    $('status').textContent = 'تم نسخ الترجمة.';
  } catch {
    $('status').textContent = 'تعذر النسخ من المتصفح.';
  }
};

$('translateBtn').onclick = translate;
$('input').addEventListener('input', () => {
  $('count').textContent = `${$('input').value.length.toLocaleString('ar')} حرف`;
});
$('settingsBtn').onclick = () => $('settingsDialog').showModal();
$('closeSettings').onclick = () => $('settingsDialog').close();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(console.error));
}

renderDirection();
