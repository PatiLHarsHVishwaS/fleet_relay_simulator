"""Simulated delivery drivers (dispatch simulation, stage 1).

A driver is placed on an existing, connected graph node (society or
restaurant) - never a new/synthetic location - and moves across the same
graph the routing algorithms already operate on.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from enum import Enum

from src.graph import Graph


class DriverStatus(str, Enum):
    AVAILABLE = "AVAILABLE"
    TO_PICKUP = "TO_PICKUP"
    TO_DROPOFF = "TO_DROPOFF"
    AVAILABLE_AFTER_DELIVERY = "AVAILABLE_AFTER_DELIVERY"


@dataclass
class Driver:
    """A simulated driver's current state."""

    driver_id: str
    current_node: str
    status: DriverStatus = DriverStatus.AVAILABLE
    assigned_order: str | None = None
    total_distance: float = 0.0
    total_travel_time: float = 0.0
    completed_orders: int = 0


def generate_drivers(graph: Graph, num_drivers: int, seed: int) -> list[Driver]:
    """Create ``num_drivers`` drivers, reproducibly, on real graph nodes.

    Drivers are distributed (with replacement) across every node that has at
    least one outgoing road, so every driver can actually move.
    """
    if num_drivers <= 0:
        raise ValueError("num_drivers must be positive.")

    rng = random.Random(seed)
    connected_nodes = sorted(nid for nid in graph.locations
                             if graph.is_connected_node(nid))
    if not connected_nodes:
        raise ValueError("Graph has no connected nodes to place drivers on.")

    return [
        Driver(driver_id=f"D{i:03d}", current_node=rng.choice(connected_nodes))
        for i in range(1, num_drivers + 1)
    ]
