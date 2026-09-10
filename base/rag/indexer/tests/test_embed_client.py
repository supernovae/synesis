"""The indexer's list interface must not require the array/ML dependency stack."""

import builtins
import importlib

import httpx
from synesis_telemetry import embed


def test_list_embeddings_work_without_numpy(monkeypatch):
    original_import = builtins.__import__

    def without_numpy(name, *args, **kwargs):
        if name == "numpy" or name.startswith("numpy."):
            raise ModuleNotFoundError("numpy is deliberately unavailable")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_numpy)
    importlib.reload(embed)
    batches = []

    def respond(request):
        import json

        batch = json.loads(request.content)["input"]
        batches.append(batch)
        return httpx.Response(200, json={"data": [{"embedding": [len(text), 0.5]} for text in batch]})

    original_client = httpx.Client
    monkeypatch.setattr(
        embed.httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs)
    )
    client = embed.EmbedClient("https://embeddings.invalid/v1", batch_size=2)
    try:
        assert client.embed_texts([]) == []
        assert batches == []
        assert client.embed_texts(["a", "bb", "ccc"]) == [[1, 0.5], [2, 0.5], [3, 0.5]]
        assert batches == [["a", "bb"], ["ccc"]]
    finally:
        client.close()
