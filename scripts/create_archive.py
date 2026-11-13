"""Packages the complete project into onchain-spot-bot-v2.zip for direct user download."""

import os
import zipfile

EXCLUDE_DIRS = {
    "node_modules",
    ".git",
    "__pycache__",
    ".vite",
    ".vite-temp",
    "dist",
}

EXCLUDE_EXTENSIONS = {
    ".pyc",
    ".tmp",
}

EXCLUDE_FILES = {
    "onchain-spot-bot-v2.zip",
}


def make_zip(source_dir: str, output_path: str):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(source_dir):
            # Prune unwanted directories
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            for file in files:
                if file in EXCLUDE_FILES:
                    continue
                ext = os.path.splitext(file)[1]
                if ext in EXCLUDE_EXTENSIONS:
                    continue

                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, source_dir)
                zipf.write(abs_path, rel_path)
    print(f"Created archive: {output_path} ({os.path.getsize(output_path):,} bytes)")


if __name__ == "__main__":
    root_dir = os.path.abspath(".")
    public_target = os.path.join(root_dir, "public", "onchain-spot-bot-v2.zip")
    root_target = os.path.join(root_dir, "onchain-spot-bot-v2.zip")

    make_zip(root_dir, public_target)
    make_zip(root_dir, root_target)
