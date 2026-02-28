"""Routing parity test: every node that sets next_node has a router that reads it.

This test encodes the contract from .cursor/rules/langgraph-state-safety.mdc.
Add new entries when introducing nodes that set next_node or new conditional edges.
"""

from __future__ import annotations

import inspect

import pytest


# Nodes that set next_node, and the router that consumes it (outgoing edge).
# Format: (node_module, node_func_name, router_func_name)
NEXT_NODE_PRODUCERS_AND_ROUTERS = [
    ("supervisor", "supervisor_node", "route_after_supervisor"),
    ("planner_node", "planner_node", "route_after_planner"),
    ("patch_integrity_gate", "patch_integrity_gate_node", "route_after_patch_integrity_gate"),
    ("executor", "sandbox_node", "route_after_sandbox"),
    ("critic", "critic_node", "route_after_critic"),
]

# Routers that MUST read next_node (or equivalent) when the node sets it.
# Keys: router name. Values: substring to grep for in router source (proof it reads the signal).
ROUTER_MUST_READ = {
    "route_after_supervisor": "next_node",
    "route_after_planner": "plan_pending_approval",  # planner uses this, not next_node directly
    "route_after_patch_integrity_gate": "next_node",
    "route_after_sandbox": "next_node",
    "route_after_critic": "critic_approved",  # critic sets next_node; router uses critic_approved/etc
}


def _get_router_source(router_name: str) -> str:
    from app.graph import (
        route_after_critic,
        route_after_patch_integrity_gate,
        route_after_planner,
        route_after_sandbox,
        route_after_supervisor,
    )

    routers = {
        "route_after_supervisor": route_after_supervisor,
        "route_after_planner": route_after_planner,
        "route_after_patch_integrity_gate": route_after_patch_integrity_gate,
        "route_after_sandbox": route_after_sandbox,
        "route_after_critic": route_after_critic,
    }
    func = routers.get(router_name)
    if func is None:
        return ""
    return inspect.getsource(func)


def _node_sets_next_node(module_name: str, func_name: str) -> bool:
    """Check if the node function returns dict with 'next_node' key."""
    mod_map = {
        "executor": ("app.nodes.executor", "sandbox_node"),
        "planner_node": ("app.nodes.planner_node", "planner_node"),
        "patch_integrity_gate": ("app.nodes.patch_integrity_gate", "patch_integrity_gate_node"),
        "supervisor": ("app.nodes.supervisor", "supervisor_node"),
        "critic": ("app.nodes.critic", "critic_node"),
    }
    try:
        mod_path, attr = mod_map.get(module_name, (None, None))
        if not mod_path:
            return False
        mod = __import__(mod_path, fromlist=[attr])
        func = getattr(mod, attr)
    except (ImportError, AttributeError):
        return False

    src = inspect.getsource(func)
    return '"next_node"' in src or "'next_node'" in src


class TestRoutingParity:
    """Ensure every node that sets next_node has a router that reads routing signals."""

    @pytest.mark.parametrize("node_module,node_func,router_name", NEXT_NODE_PRODUCERS_AND_ROUTERS)
    def test_router_reads_routing_signal(self, node_module: str, node_func: str, router_name: str):
        """Router for each next_node producer must read the routing signal."""
        assert _node_sets_next_node(node_module, node_func), (
            f"{node_module}.{node_func} should set next_node"
        )
        required = ROUTER_MUST_READ.get(router_name)
        assert required, f"Add {router_name} to ROUTER_MUST_READ with expected substring"
        source = _get_router_source(router_name)
        assert required in source, (
            f"Router {router_name} must read '{required}' (from state) before other routing logic. "
            f"Update route_after_* in graph.py."
        )
