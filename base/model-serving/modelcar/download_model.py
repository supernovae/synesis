#!/usr/bin/env python3
"""Download HuggingFace model to /models for ModelCar OCI image build.

Reads MODEL_REPO from env. HF_TOKEN optional for gated models.
Uses snapshot_download for full repo.
"""

import os
import sys

def main():
    repo = os.environ.get("MODEL_REPO")
    if not repo:
        print("MODEL_REPO required", file=sys.stderr)
        sys.exit(1)
    
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub required: pip install huggingface_hub", file=sys.stderr)
        sys.exit(1)
    
    token = os.environ.get("HF_TOKEN", "").strip() or None
    out = "/models"
    os.makedirs(out, exist_ok=True)
    
    print(f"Downloading {repo} -> {out}")
    path = snapshot_download(
        repo_id=repo,
        local_dir=out,
        token=token,
        local_dir_use_symlinks=False,
    )
    print(f"Downloaded to {path}")

if __name__ == "__main__":
    main()
