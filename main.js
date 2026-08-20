import './style.css';
import { pipeline, env } from '@huggingface/transformers';

/*
 * ============================================================
 * Offline Arabic ↔ French Translator
 * Helsinki-NLP / OPUS-MT
 *
 * التشغيل:
 *   - النماذج محلية داخل:
 *       /models/ar-fr/
 *       /models/fr-ar/
 *
 *   - ملفات ONNX Runtime WASM محلية داخل:
 *       /wasm/
 *
 *   - لا يتم السماح بنماذج بعيدة.
 *   - لا يتم السماح بطلبات خارج أصل الموقع.
 *   - inference يعمل داخل المتصفح عبر ONNX Runtime.
 *
 * مهم:
 * تسجيل Service Worker وحده لا يكفي لجعل التطبيق Offline.
 * يجب أن يكون sw.js معدًا لتخزين ملفات التطبيق والنماذج وWASM.
 * ============================================================
 */


/* ============================================================
 * 1) Application paths
 * ============================================================ */

/*
 * استخدام document.baseURI أفضل من كتابة اسم المستودع يدويًا،
 * وبالتالي يعمل على:
 *
 * https://username.github.io/repository/
 *
 * بدون الحاجة إلى كتابة اسم repository داخل الكود.
 */

const APP_BASE_URL = new URL('./', document.baseURI);

const APP_BASE = APP_BASE_URL.pathname.replace(/\/?$/, '/');

const MODELS_BASE = `${APP_BASE}models/`;
const WASM_BASE = `${APP_BASE}wasm/`;


/* ============================================================
 * 2) Transformers.js offline configuration
 * ============================================================ */

/*
 * السماح بالنماذج المحلية.
 */
env.allowLocalModels = true;

/*
 * منع Hugging Face Hub والنماذج البعيدة.
 */
env.allowRemoteModels = false;

/*
 * مكان النماذج المحلية.
 *
 * يجب أن تكون البنية مثل:
 *
 * models/
 * ├── ar-fr/
 * │   ├── config.json
 * │   ├── tokenizer.json
 * │   ├── tokenizer_config.json
 * │   └── onnx/
 * │       └── ...
 * │
 * └── fr-ar/
 *     ├── config.json
 *     ├── tokenizer.json
 *     ├── tokenizer_config.json
 *     └── onnx/
 *         └── ...
 */
env.localModelPath = MODELS_BASE;

/*
 * استخدام WASM محلي بدل CDN.
 */
env.backends.onnx.wasm.wasmPaths = WASM_BASE;

/*
 * تفعيل Browser Cache عندما يكون مدعومًا.
 */
env.useBrowserCache = true;

/*
 * تفعيل تخزين WASM.
 */
env.useWasmCache = true;


/* ============================================================
 * 3) Network protection
 * ============================================================ */

/*
 * نحتفظ بالـ fetch الأصلي.
 */
const originalFetch = globalThis.fetch.bind(globalThis);

/*
 * Transformers.js يستخدم env.fetch لطلب الملفات.
 *
 * نسمح فقط بالطلبات:
 *
 *   https://نفس-الموقع/...
 *
 * ونرفض أي طلب إلى:
 *
 *   https://huggingface.co
 *   https://cdn.jsdelivr.net
 *   https://أي-موقع-آخر
 *
 * ملاحظة:
 * هذا لا يمنع المتصفح نفسه من إجراء أي طلبات من أجزاء
 * أخرى في التطبيق، لكنه يحمي طلبات Transformers.js.
 */

env.fetch = async (input, options = {}) => {

  let targetURL;

  try {

    if (input instanceof Request) {
      targetURL = new URL(
        input.url,
        window.location.href
      );
    } else {
      targetURL = new URL(
        String(input),
        window.location.href
      );
    }

  } catch (error) {

    throw new Error(
      `Invalid request URL: ${String(input)}`
    );
  }


  /*
   * حظر أي origin خارجي.
   */
  if (
    targetURL.origin !== window.location.origin
  ) {

    throw new Error(
      `Blocked cross-origin request: ${targetURL.origin}`
    );
  }


  /*
   * السماح فقط للطلبات المحلية.
   */
  return originalFetch(
    targetURL.href,
    options
  );
};


/* ============================================================
 * 4) Application state
 * ============================================================ */

const state = {

  /*
   * ar-fr = Arabic → French
   * fr-ar = French → Arabic
   */
  direction: 'ar-fr',

  /*
   * Pipeline المستخدم حاليًا.
   */
  translator: null,

  /*
   * الاتجاه الذي تم تحميله.
   */
  loadedDirection: null,

  /*
   * Promise التحميل الحالي.
   *
   * يمنع تحميل النموذج مرتين إذا حدث طلبان متزامنان.
   */
  loadingPromise: null,

  /*
   * حالة الترجمة.
   */
  busy: false
};


/* ============================================================
 * 5) Application UI
 * ============================================================ */

const app = document.querySelector('#app');

if (!app) {

  throw new Error(
    'Fatal error: #app was not found in index.html.'
  );
}


app.innerHTML = `
  <main class="shell">

    <header class="topbar">

      <div>

        <p class="eyebrow">
          OFFLINE • ON-DEVICE
        </p>

        <h1>
          المترجم العربي الفرنسي
        </h1>

        <p class="subtitle">
          ترجمة محلية داخل المتصفح دون API سحابي.
        </p>

      </div>


      <button
        id="settingsBtn"
        class="icon-btn"
        type="button"
        aria-label="فتح الإعدادات"
        title="الإعدادات"
      >
        ⚙
      </button>

    </header>


    <section class="card">

      <div class="direction-row">

        <button
          id="fromLang"
          class="lang-pill active"
          type="button"
          disabled
        >
          العربية
        </button>


        <button
          id="swapBtn"
          class="swap-btn"
          type="button"
          aria-label="تبديل اتجاه الترجمة"
          title="تبديل الاتجاه"
        >
          ⇄
        </button>


        <button
          id="toLang"
          class="lang-pill"
          type="button"
          disabled
        >
          الفرنسية
        </button>

      </div>


      <div class="editor-grid">

        <!-- INPUT -->

        <section class="panel">

          <div class="panel-head">

            <span>
              النص
            </span>

            <button
              id="clearBtn"
              class="mini-btn"
              type="button"
            >
              مسح
            </button>

          </div>


          <textarea
            id="input"
            dir="rtl"
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            placeholder="اكتب بالعربية…"
            maxlength="20000"
          ></textarea>


          <div
            id="count"
            class="count"
          >
            0 حرف
          </div>

        </section>


        <!-- OUTPUT -->

        <section class="panel output-panel">

          <div class="panel-head">

            <span>
              الترجمة
            </span>

            <button
              id="copyBtn"
              class="mini-btn"
              type="button"
            >
              نسخ
            </button>

          </div>


          <div
            id="output"
            class="output"
            dir="ltr"
            aria-live="polite"
            aria-atomic="true"
          >
            ستظهر الترجمة هنا.
          </div>


          <div
            class="progress-wrap"
            aria-hidden="true"
          >
            <div
              id="progress"
              class="progress"
            ></div>
          </div>

        </section>

      </div>


      <button
        id="translateBtn"
        class="translate-btn"
        type="button"
      >
        ترجمة
      </button>


      <p
        id="status"
        class="status"
        role="status"
        aria-live="polite"
      >
        التطبيق جاهز. النماذج المحلية هي المصدر الوحيد للترجمة.
      </p>

    </section>


    <section class="privacy-card">

      <div class="privacy-icon">
        ✓
      </div>


      <div>

        <strong>
          خصوصيتك أولًا
        </strong>

        <p>
          الترجمة تتم داخل الجهاز.
          لا يتم إرسال النص إلى API سحابي.
        </p>

      </div>

    </section>


    <dialog id="settingsDialog">

      <div class="dialog-head">

        <h2>
          الإعدادات
        </h2>


        <button
          id="closeSettings"
          class="mini-btn"
          type="button"
        >
          إغلاق
        </button>

      </div>


      <div class="setting">

        <strong>
          التنفيذ
        </strong>

        <span>
          داخل الجهاز
        </span>

      </div>


      <div class="setting">

        <strong>
          النماذج
        </strong>

        <span>
          محلية
        </span>

      </div>


      <div class="setting">

        <strong>
          الشبكة الخارجية
        </strong>

        <span>
          محظورة
        </span>

      </div>


      <div class="setting">

        <strong>
          النموذج الحالي
        </strong>

        <span id="modelState">
          لم يتم تحميله
        </span>

      </div>


      <div class="setting">

        <strong>
          سجل النصوص
        </strong>

        <span>
          لا يوجد سجل داخل التطبيق
        </span>

      </div>


      <p class="note">

        حتى يعمل التطبيق دون اتصال فعليًا،
        يجب تضمين ملفات النماذج وملفات ONNX Runtime WASM
        وملفات التطبيق داخل المشروع، مع إعداد Service Worker
        لتخزينها محليًا.

      </p>

    </dialog>

  </main>
`;


/* ============================================================
 * 6) DOM helpers
 * ============================================================ */

const $ = (id) =>
  document.getElementById(id);


const elements = {

  input: $('input'),
  output: $('output'),
  count: $('count'),
  progress: $('progress'),
  status: $('status'),

  translateBtn: $('translateBtn'),
  swapBtn: $('swapBtn'),

  fromLang: $('fromLang'),
  toLang: $('toLang'),

  clearBtn: $('clearBtn'),
  copyBtn: $('copyBtn'),

  settingsBtn: $('settingsBtn'),
  closeSettings: $('closeSettings'),

  settingsDialog: $('settingsDialog'),

  modelState: $('modelState')
};


/* ============================================================
 * 7) UI helpers
 * ============================================================ */

function setStatus(message) {

  elements.status.textContent =
    String(message);
}


function setProgress(value) {

  const number =
    Number(value);

  const safeValue =
    Number.isFinite(number)
      ? Math.max(
          0,
          Math.min(
            100,
            number
          )
        )
      : 0;

  elements.progress.style.width =
    `${safeValue}%`;
}


function setBusy(value) {

  state.busy =
    Boolean(value);

  elements.translateBtn.disabled =
    state.busy;

  elements.swapBtn.disabled =
    state.busy;

  /*
   * أثناء الترجمة لا نسمح بتغيير الاتجاه
   * حتى لا تتداخل حالة النموذج.
   */

  elements.fromLang.disabled =
    true;

  elements.toLang.disabled =
    true;

  elements.translateBtn.setAttribute(
    'aria-busy',
    String(state.busy)
  );
}


/* ============================================================
 * 8) Direction rendering
 * ============================================================ */

function renderDirection() {

  const arabicToFrench =
    state.direction === 'ar-fr';


  elements.fromLang.textContent =
    arabicToFrench
      ? 'العربية'
      : 'الفرنسية';


  elements.toLang.textContent =
    arabicToFrench
      ? 'الفرنسية'
      : 'العربية';


  elements.input.placeholder =
    arabicToFrench
      ? 'اكتب بالعربية…'
      : 'Écrivez en français…';


  elements.input.dir =
    arabicToFrench
      ? 'rtl'
      : 'ltr';


  elements.output.dir =
    arabicToFrench
      ? 'ltr'
      : 'rtl';


  /*
   * تحديث اتجاه النص في الواجهة.
   */

  elements.input.setAttribute(
    'lang',
    arabicToFrench
      ? 'ar'
      : 'fr'
  );


  elements.output.setAttribute(
    'lang',
    arabicToFrench
      ? 'fr'
      : 'ar'
  );
}


/* ============================================================
 * 9) Text normalization
 * ============================================================ */

function normalizeText(value) {

  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/* ============================================================
 * 10) Long text splitting
 * ============================================================ */

function splitLongText(
  text,
  maxChars = 700
) {

  const normalized =
    normalizeText(text);


  if (!normalized) {
    return [];
  }


  /*
   * النص قصير بما يكفي.
   */

  if (
    normalized.length <= maxChars
  ) {
    return [normalized];
  }


  const paragraphs =
    normalized.split(/\n{2,}/);


  const chunks = [];


  for (const paragraph of paragraphs) {

    const cleanParagraph =
      paragraph.trim();


    if (!cleanParagraph) {
      continue;
    }


    /*
     * الفقرة ضمن الحجم المطلوب.
     */

    if (
      cleanParagraph.length <= maxChars
    ) {

      chunks.push(
        cleanParagraph
      );

      continue;
    }


    /*
     * نحاول أولًا تقسيم الجمل.
     *
     * يدعم:
     * .
     * !
     * ?
     * ؟
     * …
     */

    const sentences =
      cleanParagraph.match(
        /[^.!؟?…]+(?:[.!؟?…]+|$)/g
      ) || [
        cleanParagraph
      ];


    let current = '';


    for (const rawSentence of sentences) {

      const sentence =
        rawSentence.trim();


      if (!sentence) {
        continue;
      }


      /*
       * جملة ضخمة جدًا.
       *
       * سيتم قطعها إلى أجزاء لاحقًا.
       */

      if (
        sentence.length > maxChars
      ) {

        if (current) {

          chunks.push(
            current
          );

          current = '';
        }


        let remaining =
          sentence;


        while (
          remaining.length > maxChars
        ) {

          /*
           * نحاول القطع عند آخر مسافة قريبة من الحد.
           */

          const searchArea =
            remaining.slice(
              0,
              maxChars
            );


          let cut =
            searchArea.lastIndexOf(
              ' '
            );


          /*
           * إذا لم نجد مسافة،
           * نستخدم القطع الصلب.
           */

          if (
            cut < Math.floor(maxChars * 0.5)
          ) {

            cut =
              maxChars;
          }


          const piece =
            remaining
              .slice(0, cut)
              .trim();


          if (piece) {
            chunks.push(piece);
          }


          remaining =
            remaining
              .slice(cut)
              .trim();
        }


        if (remaining) {
          current =
            remaining;
        }


        continue;
      }


      const candidate =
        current
          ? `${current} ${sentence}`
          : sentence;


      if (
        candidate.length > maxChars
      ) {

        if (current) {

          chunks.push(
            current
          );
        }


        current =
          sentence;

      } else {

        current =
          candidate;
      }
    }


    if (current) {

      chunks.push(
        current
      );
    }
  }


  return chunks;
}


/* ============================================================
 * 11) Local file checking
 * ============================================================ */

/*
 * هذه الدالة تستخدم فقط لفحص ملفات صغيرة مثل JSON.
 *
 * لا نستخدم GET لملف ONNX الضخم من أجل مجرد التأكد من وجوده.
 */

async function localFileExists(
  relativePath
) {

  const url =
    new URL(
      relativePath,
      APP_BASE_URL
    );


  try {

    const response =
      await env.fetch(
        url.href,
        {
          method: 'HEAD',
          cache: 'no-store'
        }
      );


    return response.ok;

  } catch (error) {

    console.warn(
      'Local file check failed:',
      relativePath,
      error
    );

    return false;
  }
}


/* ============================================================
 * 12) Validate basic model structure
 * ============================================================ */

async function verifyModelFiles(
  modelName
) {

  const base =
    `${MODELS_BASE}${modelName}/`;


  /*
   * الملفات الرئيسية.
   */

  const requiredFiles = [

    'config.json',

    'tokenizer.json',

    'tokenizer_config.json'

  ];


  const missingFiles = [];


  for (
    const filename of requiredFiles
  ) {

    const exists =
      await localFileExists(
        `${base}${filename}`
      );


    if (!exists) {

      missingFiles.push(
        `${base}${filename}`
      );
    }
  }


  /*
   * وجود ملفات ONNX لا نستطيع التحقق منه
   * عبر directory listing على GitHub Pages.
   *
   * لذلك نترك Transformers.js يتولى اكتشاف ملف ONNX.
   */

  if (
    missingFiles.length > 0
  ) {

    throw new Error(
      [
        'Local model is incomplete.',
        'Missing files:',
        ...missingFiles
      ].join('\n')
    );
  }


  return {
    modelPath:
      base,

    onnxPath:
      `${base}onnx/`
  };
}


/* ============================================================
 * 13) Load translator
 * ============================================================ */

async function loadTranslator() {

  /*
   * النموذج المطلوب.
   */

  const modelName =
    state.direction;


  /*
   * إذا كان النموذج المطلوب محملًا مسبقًا،
   * لا نعيد تحميله.
   */

  if (
    state.translator &&
    state.loadedDirection === modelName
  ) {

    return state.translator;
  }


  /*
   * إذا كان هناك تحميل جارٍ لنفس الاتجاه،
   * ننتظر نفس الـ Promise.
   */

  if (
    state.loadingPromise &&
    state.loadedDirection === modelName
  ) {

    return state.loadingPromise;
  }


  const directionLabel =
    modelName === 'ar-fr'
      ? 'العربية → الفرنسية'
      : 'الفرنسية → العربية';


  setStatus(
    `جارٍ تجهيز نموذج ${directionLabel} محليًا…`
  );


  setProgress(3);


  /*
   * تخزين Promise التحميل لمنع التكرار.
   */

  state.loadedDirection =
    modelName;


  state.loadingPromise =
    (async () => {

      try {

        /*
         * التحقق من ملفات النموذج الأساسية.
         */

        await verifyModelFiles(
          modelName
        );


        setProgress(8);


        /*
         * مهم جدًا:
         *
         * allowRemoteModels = false
         * يمنع النماذج البعيدة.
         *
         * local_files_only = true
         * يوضح صراحة أننا نريد الملفات المحلية فقط.
         */

        const translator =
          await pipeline(
            'translation',
            modelName,
            {

              /*
               * نستخدم ONNX Runtime WASM.
               */

              device: 'wasm',


              /*
               * عدم السماح بأي محاولة للبحث
               * عن ملفات بعيدة.
               */

              local_files_only: true,


              /*
               * متابعة التحميل.
               */

              progress_callback:
                (info) => {

                  const rawProgress =
                    Number(
                      info?.progress
                    );


                  if (
                    Number.isFinite(
                      rawProgress
                    )
                  ) {

                    /*
                     * نترك مساحة لبداية
                     * التحضير والنهاية.
                     */

                    const progress =
                      8 +
                      Math.round(
                        Math.max(
                          0,
                          Math.min(
                            100,
                            rawProgress
                          )
                        ) * 0.84
                      );


                    setProgress(
                      progress
                    );
                  }
                }
            }
          );


        /*
         * تأكدنا أن pipeline عاد بنجاح.
         */

        if (
          !translator
        ) {

          throw new Error(
            'Transformers.js returned an empty pipeline.'
          );
        }


        state.translator =
          translator;


        state.loadedDirection =
          modelName;


        elements.modelState.textContent =
          `OPUS-MT • ${directionLabel}`;


        setProgress(100);


        setStatus(
          `تم تحميل نموذج ${directionLabel} محليًا.`
        );


        return translator;

      } catch (error) {

        console.error(
          'Model loading error:',
          error
        );


        state.translator =
          null;


        state.loadedDirection =
          null;


        setProgress(0);


        elements.modelState.textContent =
          'فشل التحميل';


        /*
         * نمرر الخطأ للـ translate().
         */

        throw error;

      } finally {

        /*
         * بعد انتهاء العملية لا نحتفظ بالـ Promise.
         */

        state.loadingPromise =
          null;
      }

    })();


  return state.loadingPromise;
}


/* ============================================================
 * 14) Translation
 * ============================================================ */

async function translate() {

  if (
    state.busy
  ) {
    return;
  }


  const rawText =
    elements.input.value;


  const text =
    normalizeText(
      rawText
    );


  if (!text) {

    elements.output.textContent =
      'أدخل نصًا أولًا.';

    setStatus(
      'لم يتم إدخال نص.'
    );

    return;
  }


  const chunks =
    splitLongText(
      text
    );


  if (
    chunks.length === 0
  ) {

    elements.output.textContent =
      'أدخل نصًا صالحًا.';

    return;
  }


  setBusy(true);

  setProgress(1);


  elements.output.textContent =
    'جارٍ تجهيز النموذج…';


  try {

    /*
     * تحميل النموذج.
     */

    const translator =
      await loadTranslator();


    if (
      typeof translator !==
      'function'
    ) {

      throw new Error(
        'Translation pipeline is not callable.'
      );
    }


    /*
     * مكان النتائج.
     */

    const results = [];


    /*
     * الترجمة جزءًا جزءًا.
     */

    for (
      let index = 0;
      index < chunks.length;
      index++
    ) {

      const chunk =
        chunks[index];


      if (!chunk) {

        results.push('');

        continue;
      }


      setStatus(
        `جاري ترجمة الجزء ${
          index + 1
        } من ${
          chunks.length
        }…`
      );


      const result =
        await translator(
          chunk,
          {

            /*
             * حد أقصى مناسب للنص الناتج.
             */

            max_new_tokens:
              256,


            /*
             * beam search لتحسين النتيجة
             * في نماذج الترجمة.
             */

            num_beams:
              4,


            /*
             * ترجمة deterministic.
             */

            do_sample:
              false,


            /*
             * لا نريد إعادة النص الأصلي
             * في output.
             */

            return_full_text:
              false
          }
        );


      /*
       * Transformers.js translation pipeline
       * تعيد مصفوفة من النتائج.
       */

      const translated =
        result?.[0]?.translation_text;


      if (
        typeof translated !==
        'string'
      ) {

        console.error(
          'Unexpected translation result:',
          result
        );


        throw new Error(
          'The local model returned an invalid translation result.'
        );
      }


      results.push(
        translated.trim()
      );


      /*
       * تحديث التقدم.
       */

      const progress =
        Math.round(
          (
            (index + 1) /
            chunks.length
          ) * 100
        );


      setProgress(
        progress
      );


      /*
       * عرض النتيجة تدريجيًا.
       *
       * هذا يعطي المستخدم إحساسًا أن التطبيق
       * يعمل حتى مع النصوص الطويلة.
       */

      elements.output.textContent =
        results.join('\n\n');
    }


    /*
     * النتيجة النهائية.
     */

    elements.output.textContent =
      results.join('\n\n');


    setProgress(100);


    setStatus(
      'تمت الترجمة داخل الجهاز بنجاح.'
    );

  } catch (error) {

    console.error(
      'Translation error:',
      error
    );


    const message =
      error instanceof Error
        ? error.message
        : String(error);


    elements.output.textContent =
      'فشلت الترجمة المحلية.';


    /*
     * رسائل مفيدة بدل رسالة عامة فقط.
     */

    if (
      /missing|not found|local model/i.test(
        message
      )
    ) {

      setStatus(
        'ملفات النموذج المحلية غير مكتملة. تحقق من models/ar-fr أو models/fr-ar.'
      );

    } else if (
      /onnx|wasm|runtime/i.test(
        message
      )
    ) {

      setStatus(
        'تعذر تشغيل ONNX Runtime. تحقق من مجلد wasm وملفاته.'
      );

    } else {

      setStatus(
        'حدث خطأ أثناء الترجمة المحلية. افتح Console لمعرفة التفاصيل.'
      );
    }

  } finally {

    setBusy(false);

  }
}


/* ============================================================
 * 15) Swap direction
 * ============================================================ */

function swapDirection() {

  if (
    state.busy
  ) {
    return;
  }


  state.direction =
    state.direction === 'ar-fr'
      ? 'fr-ar'
      : 'ar-fr';


  /*
   * لا نحتفظ بالنموذج القديم،
   * لأن الاتجاه الجديد يحتاج pipeline آخر.
   */

  state.translator =
    null;


  state.loadedDirection =
    null;


  state.loadingPromise =
    null;


  renderDirection();


  elements.output.textContent =
    'ستظهر الترجمة هنا.';


  setProgress(0);


  setStatus(
    state.direction === 'ar-fr'
      ? 'تم اختيار العربية → الفرنسية.'
      : 'تم اختيار الفرنسية → العربية.'
  );
}


/* ============================================================
 * 16) Clear
 * ============================================================ */

function clearText() {

  elements.input.value =
    '';

  elements.output.textContent =
    'ستظهر الترجمة هنا.';

  elements.count.textContent =
    '0 حرف';

  setProgress(0);

  setStatus(
    'تم مسح النص.'
  );

  elements.input.focus();
}


/* ============================================================
 * 17) Clipboard
 * ============================================================ */

async function copyTranslation() {

  const value =
    elements.output.textContent.trim();


  if (
    !value ||
    value === 'ستظهر الترجمة هنا.'
  ) {

    setStatus(
      'لا توجد ترجمة لنسخها.'
    );

    return;
  }


  try {

    /*
     * Clipboard API.
     */

    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText ===
        'function'
    ) {

      await navigator.clipboard.writeText(
        value
      );


    } else {

      /*
       * Fallback للمتصفحات التي لا توفر
       * Clipboard API.
       */

      const temporary =
        document.createElement(
          'textarea'
        );


      temporary.value =
        value;


      temporary.setAttribute(
        'readonly',
        ''
      );


      temporary.style.position =
        'fixed';

      temporary.style.left =
        '-9999px';

      temporary.style.top =
        '0';


      document.body.appendChild(
        temporary
      );


      temporary.focus();

      temporary.select();


      const copied =
        document.execCommand(
          'copy'
        );


      temporary.remove();


      if (!copied) {

        throw new Error(
          'document.execCommand(copy) failed.'
        );
      }
    }


    setStatus(
      'تم نسخ الترجمة.'
    );

  } catch (error) {

    console.error(
      'Copy error:',
      error
    );


    setStatus(
      'تعذر نسخ الترجمة.'
    );
  }
}


/* ============================================================
 * 18) Input counter
 * ============================================================ */

function updateCounter() {

  const length =
    elements.input.value.length;


  elements.count.textContent =
    `${length.toLocaleString('ar')} حرف`;
}


/* ============================================================
 * 19) Settings dialog
 * ============================================================ */

function openSettings() {

  const dialog =
    elements.settingsDialog;


  if (
    typeof dialog.showModal ===
    'function'
  ) {

    dialog.showModal();

  } else {

    /*
     * Fallback للمتصفحات القديمة.
     */

    dialog.setAttribute(
      'open',
      ''
    );
  }
}


function closeSettings() {

  const dialog =
    elements.settingsDialog;


  if (
    typeof dialog.close ===
    'function'
  ) {

    dialog.close();

  } else {

    dialog.removeAttribute(
      'open'
    );
  }
}


/* ============================================================
 * 20) Service Worker registration
 * ============================================================ */

async function registerServiceWorker() {

  if (
    !('serviceWorker' in navigator)
  ) {

    console.warn(
      'Service Worker is not supported.'
    );

    return;
  }


  try {

    const registration =
      await navigator.serviceWorker.register(
        `${APP_BASE}sw.js`,
        {
          scope:
            APP_BASE
        }
      );


    console.log(
      'Service Worker registered:',
      registration.scope
    );

  } catch (error) {

    /*
     * عدم وجود Service Worker لا يمنع
     * تشغيل التطبيق أثناء الاتصال،
     * لكنه يمنع Offline الكامل بعد إعادة فتح الصفحة.
     */

    console.error(
      'Service Worker registration failed:',
      error
    );


    setStatus(
      'يعمل المترجم، لكن التخزين Offline الكامل غير مفعل.'
    );
  }
}


/* ============================================================
 * 21) Event listeners
 * ============================================================ */

elements.translateBtn.addEventListener(
  'click',
  translate
);


elements.swapBtn.addEventListener(
  'click',
  swapDirection
);


elements.clearBtn.addEventListener(
  'click',
  clearText
);


elements.copyBtn.addEventListener(
  'click',
  copyTranslation
);


elements.input.addEventListener(
  'input',
  updateCounter
);


elements.settingsBtn.addEventListener(
  'click',
  openSettings
);


elements.closeSettings.addEventListener(
  'click',
  closeSettings
);


/*
 * إغلاق dialog عند الضغط خارج مربع المحتوى.
 */

elements.settingsDialog.addEventListener(
  'click',
  (event) => {

    if (
      event.target !==
      elements.settingsDialog
    ) {
      return;
    }


    closeSettings();
  }
);


/*
 * Ctrl/Cmd + Enter للترجمة.
 */

elements.input.addEventListener(
  'keydown',
  (event) => {

    const modifier =
      event.ctrlKey ||
      event.metaKey;


    if (
      modifier &&
      event.key === 'Enter'
    ) {

      event.preventDefault();

      translate();
    }
  }
);


/* ============================================================
 * 22) Initial state
 * ============================================================ */

renderDirection();

updateCounter();

setProgress(0);

setStatus(
  'المترجم جاهز. الترجمة تعتمد على النماذج المحلية فقط.'
);


/* ============================================================
 * 23) Start Service Worker
 * ============================================================ */

window.addEventListener(
  'load',
  () => {
    registerServiceWorker();
  },
  {
    once: true
  }
);
