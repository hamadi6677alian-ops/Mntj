from pathlib import Path
import shutil
import subprocess
import sys

from huggingface_hub import snapshot_download
from transformers import AutoTokenizer


ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "public" / "models"

MODELS.mkdir(parents=True, exist_ok=True)


def run(cmd):
    print("+", " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, check=True)


def prepare_model(model_id: str, model_name: str):
    out_dir = MODELS / model_name
    onnx_dir = out_dir / "onnx"

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n===== Preparing {model_id} =====", flush=True)

    # تنزيل tokenizer/config من النموذج الأصلي.
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    tokenizer.save_pretrained(out_dir)

    # التأكد من وجود tokenizer.json.
    tokenizer_json = out_dir / "tokenizer.json"
    if not tokenizer_json.exists():
        tokenizer.save_pretrained(out_dir, legacy_format=False)

    # ملفات الإعداد الإضافية.
    cache_dir = Path(
        snapshot_download(
            model_id,
            allow_patterns=[
                "config.json",
                "generation_config.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
                "source.spm",
                "target.spm",
                "vocab.json",
            ],
        )
    )

    for filename in [
        "config.json",
        "generation_config.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "source.spm",
        "target.spm",
        "vocab.json",
    ]:
        source = cache_dir / filename
        destination = out_dir / filename

        if source.exists():
            shutil.copy2(source, destination)

    # تحويل Marian encoder-decoder إلى ONNX.
    run(
        [
            sys.executable,
            "-m",
            "optimum.exporters.onnx",
            "--model",
            model_id,
            "--task",
            "text2text-generation-with-past",
            str(onnx_dir),
        ]
    )

    print(f"Finished: {model_id}", flush=True)


prepare_model(
    "Helsinki-NLP/opus-mt-ar-fr",
    "ar-fr",
)

prepare_model(
    "Helsinki-NLP/opus-mt-fr-ar",
    "fr-ar",
)

print("\nDone. Models are in public/models/", flush=True)
