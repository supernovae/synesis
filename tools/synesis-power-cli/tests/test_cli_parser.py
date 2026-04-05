from __future__ import annotations

from synesis_power_cli.cli import build_parser


def test_parser_accepts_kpi_snapshot_args() -> None:
    parser = build_parser()
    args = parser.parse_args(
        [
            "kpi",
            "snapshot",
            "--admin-base-url",
            "http://localhost:8080",
            "--since-hours",
            "72",
            "--bucket-minutes",
            "30",
        ]
    )
    assert args.group == "kpi"
    assert args.kpi_cmd == "snapshot"
    assert args.since_hours == 72
    assert args.bucket_minutes == 30
