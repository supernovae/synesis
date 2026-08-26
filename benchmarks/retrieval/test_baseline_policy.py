from __future__ import annotations

import unittest

import httpx
from baseline_policy import BenchmarkContractError, find_regressions, validate_snapshot
from bench_hybrid import native_search


def snapshot(
    *,
    query_ids: tuple[str, ...] = ("q1", "q2"),
    recall_5: float = 0.8,
    recall_10: float = 0.9,
    mrr_10: float = 0.7,
    ndcg_10: float = 0.75,
) -> dict:
    return {
        "aggregate": {
            "recall@5": recall_5,
            "recall@10": recall_10,
            "mrr@10": mrr_10,
            "ndcg@10": ndcg_10,
            "query_count": len(query_ids),
        },
        "per_query": [{"query_id": query_id} for query_id in query_ids],
    }


class BaselinePolicyTests(unittest.TestCase):
    def test_valid_snapshot_is_accepted(self) -> None:
        self.assertEqual(validate_snapshot(snapshot(), "candidate"), {"q1", "q2"})

    def test_zero_query_seed_is_rejected(self) -> None:
        seed = snapshot(query_ids=(), recall_5=0, recall_10=0, mrr_10=0, ndcg_10=0)
        with self.assertRaisesRegex(BenchmarkContractError, "query_count"):
            validate_snapshot(seed, "baseline")

    def test_zero_signal_baseline_is_rejected(self) -> None:
        seed = snapshot(recall_5=0, recall_10=0, mrr_10=0, ndcg_10=0)
        with self.assertRaisesRegex(BenchmarkContractError, "zero signal"):
            validate_snapshot(seed, "baseline")

    def test_query_set_drift_requires_explicit_promotion(self) -> None:
        with self.assertRaisesRegex(BenchmarkContractError, "different query sets"):
            find_regressions(snapshot(query_ids=("q1", "q3")), snapshot(), 0.05)

    def test_relative_drop_over_tolerance_is_reported(self) -> None:
        regressions = find_regressions(snapshot(recall_5=0.7), snapshot(recall_5=0.8), 0.05)
        self.assertEqual(len(regressions), 1)
        self.assertIn("recall@5", regressions[0])

    def test_drop_at_tolerance_is_accepted(self) -> None:
        self.assertEqual(find_regressions(snapshot(recall_5=0.76), snapshot(recall_5=0.8), 0.05), [])

    def test_individual_zero_metric_does_not_divide_by_zero(self) -> None:
        self.assertEqual(find_regressions(snapshot(recall_5=0.2), snapshot(recall_5=0), 0.05), [])

    def test_native_search_parses_current_nornic_http_shape(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/nornicdb/search")
            return httpx.Response(
                200,
                json=[
                    {
                        "node": {
                            "id": "storage-1",
                            "labels": ["ContentNode"],
                            "properties": {"id": "chunk-1", "kind": "Chunk"},
                        },
                        "score": 0.82,
                        "rrf_score": 0.031,
                        "vector_rank": 2,
                        "bm25_rank": 1,
                    }
                ],
            )

        with httpx.Client(base_url="http://nornic.test", transport=httpx.MockTransport(handler)) as client:
            rows, method = native_search(client, database="nornic", query="hybrid", top_k=5)

        self.assertEqual(rows[0]["id"], "chunk-1")
        self.assertEqual(rows[0]["rrf_score"], 0.031)
        self.assertEqual(method, "rrf_hybrid+rerank")


if __name__ == "__main__":
    unittest.main()
