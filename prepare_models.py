from pathlib import Path
import shutil
import subprocess
import sys

from huggingface_hub import snapshot_download
from transformers import AutoTokenizer, PreTrainedTokenizerFast
from transformers.convert_slow_tokenizer import convert_slow_tokenizer


ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "public" / "models"
MODELS.mkdir(parents=True, exist_ok=True)


MODEL_FILES = [
    "config.json",
    "generation_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "source.spm",
    "target.spm",
    "vocab.json",
]


def run(command):
    print("+", " ".join(map(str, command)), flush=True)
    subprocess.run(command, check=True)


def copy_model_files(model_id: str, output_dir: Path):
    cache_dir = Path(
        snapshot_download(
            repo_id=model_id,
            allow_patterns=MODEL_FILES,
        )
    )

    for filename in MODEL_FILES:
        source = cache_dir / filename

        if not source.exists():
            continue

        destination = output_dir / filename
        shutil.copy2(source, destination)

        print(
            f"copied {filename}",
            flush=True,
        )


def create_fast_tokenizer(model_id: str, output_dir: Path):
    print(
        f"Creating tokenizer.json for {model_id}...",
        flush=True,
    )

    # Load the original Helsinki-NLP tokenizer.
    slow_tokenizer = AutoTokenizer.from_pretrained(
        model_id,
        use_fast=False,
    )

    # Convert Marian/SentencePiece tokenizer to the
    # Hugging Face tokenizers backend.
    backend_tokenizer = convert_slow_tokenizer(
        slow_tokenizer
    )

    # Wrap the converted backend as a fast tokenizer.
    fast_tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=backend_tokenizer,

        unk_token=slow_tokenizer.unk_token,
        bos_token=slow_tokenizer.bos_token,
        eos_token=slow_tokenizer.eos_token,
        pad_token=slow_tokenizer.pad_token,

        additional_special_tokens=(
            slow_tokenizer.additional_special_tokens
            or []
        ),

        model_max_length=(
            slow_tokenizer.model_max_length
        ),

        padding_side=slow_tokenizer.padding_side,
        truncation_side=slow_tokenizer.truncation_side,
    )

    # Save tokenizer.json plus tokenizer_config.json etc.
    fast_tokenizer.save_pretrained(
        output_dir
    )

    tokenizer_json = (
        output_dir / "tokenizer.json"
    )

    if not tokenizer_json.exists():
        raise RuntimeError(
            f"tokenizer.json was not created for {model_id}"
        )

    print(
        f"created {tokenizer_json}",
        flush=True,
    )


def export_onnx(model_id: str, output_dir: Path):
    onnx_dir = output_dir / "onnx"
    onnx_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    print(
        f"Exporting {model_id} to ONNX...",
        flush=True,
    )

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


def prepare_model(
    model_id: str,
    model_name: str,
):
    output_dir = MODELS / model_name

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    print(
        "\n========================================",
        flush=True,
    )

    print(
        f"Preparing {model_id}",
        flush=True,
    )

    print(
        "========================================\n",
        flush=True,
    )

    # 1. Original configuration/tokenizer files.
    copy_model_files(
        model_id,
        output_dir,
    )

    # 2. Create tokenizer.json for Transformers.js.
    create_fast_tokenizer(
        model_id,
        output_dir,
    )

    # 3. Export the actual Marian model to ONNX.
    export_onnx(
        model_id,
        output_dir,
    )

    print(
        f"\nFinished {model_id}",
        flush=True,
    )


prepare_model(
    "Helsinki-NLP/opus-mt-ar-fr",
    "ar-fr",
)


prepare_model(
    "Helsinki-NLP/opus-mt-fr-ar",
    "fr-ar",
)


print(
    "\nAll OPUS-MT models are ready.",
    flush=True,
)

print(
    f"Models directory: {MODELS}",
    flush=True,
)
