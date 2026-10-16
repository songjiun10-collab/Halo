"""Bridge to facebook/rebalancer for assignment-solver.js.

stdin : {"objects": {name: size}, "containers": {name: capacity}, "current": {object: container} | null}
stdout: {"status": "ok", "assignment": {object: container}}  or  {"status": "unavailable", "reason": "..."}

Uses the documented ProblemSolver API (README of facebook/rebalancer): one capacity constraint on a single
dimension, local search with single moves and swaps. The caller checks the answer; this file does not trust itself.
"""
import json
import sys


def main() -> int:
    problem = json.load(sys.stdin)
    try:
        from rebalancer import ProblemSolver
        from rebalancer.specs import (
            CapacitySpec, ConstraintSpec, LocalSearchSolverSpec,
            MoveTypeSpec, SingleMoveTypeSpec, SwapMoveTypeSpec, SolverSpec,
        )
    except Exception as error:  # not installed, or a build that cannot load
        json.dump({"status": "unavailable", "reason": type(error).__name__}, sys.stdout)
        return 0

    objects, containers = problem["objects"], problem["containers"]
    first = sorted(containers)[0]
    start = {name: [] for name in containers}
    for obj in objects:
        home = (problem.get("current") or {}).get(obj)
        start[home if home in start else first].append(obj)

    solver = ProblemSolver(service_name="halo", service_scope="assignment")
    (solver
        .set_object_name("object")
        .set_container_name("container")
        .set_assignment(start)
        .add_object_dimension("size", objects)
        .add_container_dimension("size", containers)
        .add_constraint(ConstraintSpec(capacitySpec=CapacitySpec(name="capacity", scope="container", dimension="size")))
        .add_solver(SolverSpec(localSearchSolverSpec=LocalSearchSolverSpec(
            moveTypeList=[MoveTypeSpec(singleMoveTypeSpec=SingleMoveTypeSpec()),
                          MoveTypeSpec(swapMoveTypeSpec=SwapMoveTypeSpec())]))))
    solution = solver.solve()
    json.dump({"status": "ok", "assignment": solution["assignment"]}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
