import './style.css';
import { pipeline, env } from '@huggingface/transformers';

// GitHub Pages: https://hamadi6677alian-ops.github.io/Mntj/
const BASE = '/Mntj/';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${BASE}models/`;
env.useBrowserCache = true;
env.useWasmCache = true;

const app = document.querySelector('#app');

const state = {
  direction: 'ar-fr',
  translator: null,
  loadedFor: null,
  busy: false
};

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">OFFLINE • ON-DEVICE</p>
        <h1>المترجم العربي الفرنسي</h1>
        <p class="subtitle">ترجمة محلية داخل المتصفح دون API أو حساب أو إعلانات.</p>
      </div>
      <button id="settingsBtn" class="icon-btn" aria-label="الإعدادات">⚙</button>
    </header>

    <section class="card">
      <div class="direction-row">
        <button id="fromLang" class="lang-pill active">العربية</button>
        <button id="swapBtn" class="swap-btn" aria-label="تبديل الاتجاه">⇄</button>
        <button id="toLang" class="lang-pill">الفرنسية</button>
      </div>

      <div class="editor-grid">
        <section class="panel">
          <div class="panel-head">
            <span>النص</span>
            <button id="clearBtn" class="mini-btn">مسح</button>
          </div>

          <textarea
            id="input"
            dir="auto"
            spellcheck="false"
            placeholder="اكتب بالعربية…"
          ></textarea>

          <div class="count" id="count">0 حرف</div>
        </section>

        <section class="panel output-panel">
          <div class="panel-head">
            <span>الترجمة</span>
            <button id="copyBtn" class="mini-btn">نسخ</button>
          </div>

          <div id="output" class="output" dir="auto">
            ستظهر الترجمة هنا.
          </div>

          <div class="progress-wrap">
            <div id="progress" class="progress"></div>
          </div>
        </section>
      </div>

      <button id="translateBtn" class="translate-btn">
        ترجمة
      </button>

      <p id="status" class="status">
        الموقع يعمل محليًا.
      </p>
    </section>

    <section class="privacy-card">
      <div class="privacy-icon">✓</div>
      <div>
        <strong>خصوصيتك أولًا</strong>
        <p>
          الترجمة لا تستخدم API ولا ترسل النص إلى خادم ترجمة.
        </p>
      </div>
    </section>

    <dialog id="settingsDialog">
      <div class="dialog-head">
        <h2>الإعدادات</h2>
        <button id="closeSettings" class="mini-btn">إغلاق</button>
      </div>

      <div class="setting">
        <strong>التنفيذ</strong>
        <span>داخل المتصفح</span>
      </div>

      <div class="setting">
        <strong>النماذج</strong>
        <span id="modelState">OPUS-MT</span>
      </div>

      <div class="setting">
        <strong>النصوص</strong>
        <span>لا تُحفظ تلقائيًا</span>
      </div>

      <p class="note">
        النماذج المطلوبة موجودة محليًا داخل الموقع.
      </p>
    </dialog>
  </main>
`;

const $ = (id) => document.getElementById(id);

function renderDirection() {
  const ar = state.direction === 'ar-fr';

  $('fromLang').textContent = ar ? 'العربية' : 'الفرنسية';
  $('toLang').textContent = ar ? 'الفرنسية' : 'العربية';

  $('input').placeholder =
    ar ? 'اكتب بالعربية…' : 'Écrivez en français…';
}

function splitLongText(text, limit = 380) {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/);

  const chunks = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      chunks.push('');
      continue;
    }

    const sentences =
      paragraph.match(/[^.!؟?…]+(?:[.!؟?…]+|$)/g) ||
      [paragraph];

    let current = '';

    for (const sentence of sentences) {
      const clean = sentence.trim();
      if (!clean) continue;

      const next = current
        ? `${current} ${clean}`
        : clean;

      if (next.length > limit && current) {
        chunks.push(current);
        current = clean;
      } else {
        current = next;
      }
    }

    if (current) {
      chunks.push(current);
    }
  }

  return chunks;
}

async function loadTranslator() {
  if (
    state.translator &&
    state.loadedFor === state.direction
  ) {
    return state.translator;
  }

  const modelName = state.direction;

  $('status').textContent =
    `جارٍ تحميل نموذج ${
      modelName === 'ar-fr'
        ? 'العربية → الفرنسية'
        : 'الفرنسية → العربية'
    } من ملفات الموقع…`;

  $('progress').style.width = '5%';

  try {
    /*
     * مهم:
     * نستخدم اسم المجلد فقط لأن localModelPath
     * أصبح /Mntj/models/
     */
    state.translator = await pipeline(
      'translation',
      modelName,
      {
        device: 'wasm',
        progress_callback: (info) => {
          if (typeof info?.progress === 'number') {
            const value = Math.max(
              5,
              Math.min(
                90,
                Math.round(info.progress * 85)
              )
            );

            $('progress').style.width = `${value}%`;
          }
        }
      }
    );

    state.loadedFor = modelName;

    $('modelState').textContent =
      `OPUS-MT ${modelName}`;

    $('progress').style.width = '100%';

    $('status').textContent =
      'تم تحميل النموذج محليًا.';

    return state.translator;

  } catch (error) {
    console.error('MODEL ERROR:', error);

    $('progress').style.width = '0%';

    $('status').textContent =
      'تعذر تحميل نموذج OPUS-MT المحلي. تأكد من وجود مجلد models.';

    $('output').textContent =
      'خطأ في تشغيل النموذج المحلي. لم يتم إرسال النص إلى الإنترنت.';

    throw error;
  }
}

async function translate() {
  if (state.busy) return;

  const text = $('input').value.trim();

  if (!text) {
    $('output').textContent =
      'أدخل نصًا أولًا.';
    return;
  }

  state.busy = true;
  $('translateBtn').disabled = true;
  $('progress').style.width = '5%';

  try {
    const translator =
      await loadTranslator();

    const parts =
      splitLongText(text);

    const results = [];

    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) {
        results.push('');
        continue;
      }

      const result =
        await translator(
          parts[i],
          {
            max_new_tokens: 256,
            num_beams: 4
          }
        );

      results.push(
        result?.[0]?.translation_text ?? ''
      );

      const progress =
        15 +
        Math.round(
          ((i + 1) / parts.length) * 85
        );

      $('progress').style.width =
        `${progress}%`;
    }

    $('output').textContent =
      results.join('\n\n');

    $('status').textContent =
      'تمت الترجمة محليًا.';

  } catch (error) {
    console.error(error);
  } finally {
    state.busy = false;
    $('translateBtn').disabled = false;
  }
}

$('swapBtn').onclick = () => {
  state.direction =
    state.direction === 'ar-fr'
      ? 'fr-ar'
      : 'ar-fr';

  state.translator = null;
  state.loadedFor = null;

  renderDirection();

  $('output').textContent =
    'ستظهر الترجمة هنا.';

  $('progress').style.width = '0%';

  $('status').textContent =
    'تم تبديل الاتجاه.';
};

$('clearBtn').onclick = () => {
  $('input').value = '';
  $('output').textContent =
    'ستظهر الترجمة هنا.';
  $('count').textContent =
    '0 حرف';
};

$('copyBtn').onclick = async () => {
  const value =
    $('output').textContent.trim();

  if (
    !value ||
    value === 'ستظهر الترجمة هنا.'
  ) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    $('status').textContent =
      'تم نسخ الترجمة.';
  } catch {
    $('status').textContent =
      'تعذر النسخ من المتصفح.';
  }
};

$('translateBtn').onclick =
  translate;

$('input').addEventListener(
  'input',
  () => {
    $('count').textContent =
      `${$('input').value.length.toLocaleString('ar')} حرف`;
  }
);

$('settingsBtn').onclick =
  () => $('settingsDialog').showModal();

$('closeSettings').onclick =
  () => $('settingsDialog').close();

if ('serviceWorker' in navigator) {
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker
        .register(`${BASE}sw.js`)
        .catch(console.error);
    }
  );
}

renderDirection();
