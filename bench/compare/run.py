#!/usr/bin/env python3
"""Pinned, rotated fresh processes. Medians, never cherry-picked best runs."""
import argparse
import json
import os
import pathlib
import platform
import statistics
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
LIBRARIES = ["manual", "binopsy", "binary-parser", "binary-parser-encoder", "restructure", "typed-binary", "micro-packed", "@solana/codecs", "@pretendonetwork/binary-parser", "@solana/buffer-layout"]
SCENARIOS = ["header", "record", "union", "bits", "numeric", "text", "points"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--operation", choices=["decode", "encode"], help="Limit a focused follow-up to one operation")
    parser.add_argument("--cpu", type=int, default=min(os.sched_getaffinity(0)))
    parser.add_argument("--libraries", default=",".join(LIBRARIES))
    parser.add_argument("--scenarios", default=",".join(SCENARIOS))
    parser.add_argument("--output", default=str(HERE / "results/comparison.json"))
    parser.add_argument("--resume", action="store_true", help="Continue an interrupted output JSON without repeating saved cells")
    parser.add_argument("--modes", default="reader,pick,skip,trace,encodeInto,sizeOf,stream,stream-small,stream-tiny")
    parser.add_argument("--cold", action="store_true", help="Fresh-process binopsy phase breakdown (includes wide128)")
    parser.add_argument("--extras", action="store_true", help="Binopsy-only mode regression workloads")
    parser.add_argument("--source", help="Single-run binopsy src directory (for historical comparisons)")
    parser.add_argument("--a", help="A/B: baseline src directory")
    parser.add_argument("--b", help="A/B: candidate src directory")
    args = parser.parse_args()
    env = dict(os.environ, NODE_OPTIONS="--max-old-space-size=1536")
    node = subprocess.check_output(["node", "--version"], env=env, text=True, timeout=20).strip()
    report = {"machine": platform.platform(), "node": node, "cpu": args.cpu, "command": sys.argv, "rounds": args.rounds, "batchOverrides": {k: os.environ[k] for k in ["COUNT", "RUNS", "WARMUPS", "WARM_MS"] if k in os.environ}, "samples": []}
    if args.resume and pathlib.Path(args.output).exists():
        saved = json.loads(pathlib.Path(args.output).read_text())
        for key in ["machine", "node", "cpu", "rounds"]:
            if saved[key] != report[key]:
                parser.error(f"Cannot resume: {key} changed")
        if saved.get("batchOverrides", {}) != report["batchOverrides"]:
            parser.error("Cannot resume: batch overrides changed")
        previous = parser.parse_args(saved["command"][1:])
        for key in ["libraries", "scenarios", "operation", "modes", "extras", "cold", "source", "a", "b"]:
            if getattr(previous, key) != getattr(args, key):
                parser.error(f"Cannot resume: {key} changed")
        report = saved
        report.setdefault("resumedCommands", []).append(sys.argv)
    completed = {(x["round"], x["variant"], x["library"], x["scenario"], x["operation"]) for x in report["samples"]}
    operations = [args.operation] if args.operation else ["decode", "encode"]
    jobs = [(lib, s, op) for s in args.scenarios.split(",") for lib in args.libraries.split(",") for op in operations]
    if args.extras:
        jobs = [("binopsy", s, "extra") for s in args.modes.split(",")]
    if args.cold:
        jobs = [("binopsy", s, op) for s in args.scenarios.split(",") + ["wide128"] for op in operations]
    variants = [("A", args.a), ("B", args.b)] if args.a and args.b else [("current", args.source)]
    for r in range(args.rounds):
        ordered = jobs[r % len(jobs):] + jobs[:r % len(jobs)]
        if r % 2:
            ordered.reverse()
        for lib, scenario, op in ordered:
            wrote = False
            for variant, src in variants if r % 2 == 0 else list(reversed(variants)):
                if (r, variant, lib, scenario, op) in completed:
                    continue
                wrote = True
                child_env = dict(env)
                if src:
                    child_env["BINOPSY_SRC"] = str(pathlib.Path(src).resolve())
                child = subprocess.run(["taskset", "-c", str(args.cpu), "node", str(HERE / ("cold.mjs" if args.cold else "extra.mjs" if args.extras else "worker.mjs")), lib, scenario, op, (src or str(HERE.parent.parent / "lib")) if args.cold else src or "", os.environ.get("COUNT", str(128 if scenario == "numeric" else 10240 if args.extras or scenario in ["record", "points", "text"] else 98304)), os.environ.get("RUNS", "9"), os.environ.get("WARMUPS", "5"), os.environ.get("WARM_MS", "250")], env=child_env, capture_output=True, text=True, timeout=180)
                if child.returncode:
                    sys.exit(f"{lib}/{scenario}/{op}\n{child.stdout}\n{child.stderr}")
                row = json.loads(child.stdout)
                row.update(round=r, variant=variant)
                report["samples"].append(row)
                output = pathlib.Path(args.output)
                output.parent.mkdir(parents=True, exist_ok=True)
                pending = output.with_suffix(output.suffix + ".tmp")
                pending.write_text(json.dumps(report, indent=2) + "\n")
                pending.replace(output)
            if wrote:
                print(f"round {r + 1}/{args.rounds}: {lib}/{scenario}/{op}", file=sys.stderr, flush=True)
    if args.cold:
        print("| Scenario | Operation | Variant | Import ms | Definition ms | Compile ms | Call ms | First use ms | Total ms |")
        print("|---|---|---|---:|---:|---:|---:|---:|---:|")
        for lib, scenario, op in jobs:
            for variant, _ in variants:
                rows = [v for v in report["samples"] if (v["scenario"], v["operation"], v["variant"]) == (scenario, op, variant)]
                cells = [f"{statistics.median(v[k] for v in rows):.3f}" for k in ["importMs", "definitionMs", "compileMs", "callMs", "firstMs"]]
                cells.append(f"{statistics.median(v['importMs'] + v['firstMs'] for v in rows):.3f}")
                print("| " + " | ".join([scenario, op, variant] + cells) + " |")
        return
    print("| Scenario | Library | Variant | Operation | M ops/s | MB/s | First use ms | Process range MB/s |")
    print("|---|---|---|---|---:|---:|---:|---:|")
    for lib, scenario, op in jobs:
        for variant, _ in variants:
            rows = [v for v in report["samples"] if (v["library"], v["scenario"], v["operation"], v["variant"]) == (lib, scenario, op, variant)]
            if "skip" in rows[0]:
                print(f"| {scenario} | {lib} | {variant} | {op} | — | — | — | {rows[0]['skip']} |")
                continue
            med = lambda key: statistics.median(v[key] for v in rows)
            print(f"| {scenario} | {lib} | {variant} | {op} | {med('ops') / 1e6:.3f} | {med('mbps'):.1f} | {med('firstMs'):.3f} | {min(v['mbps'] for v in rows):.1f}–{max(v['mbps'] for v in rows):.1f} |")


if __name__ == "__main__":
    main()
