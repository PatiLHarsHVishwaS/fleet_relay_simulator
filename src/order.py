"""Simulated delivery orders (dispatch simulation, stage 2).

Every order links a real restaurant node to a real society node from the
existing dataset. An order is only ever created for a pair that already has
a restaurant -> society route in the graph (checked with the existing
Dijkstra search), so the simulation never has to handle an unroutable order.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum

from src.dijkstra import dijkstra
from src.graph import Graph


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    ASSIGNED = "ASSIGNED"
    PICKED_UP = "PICKED_UP"
    DELIVERED = "DELIVERED"


# The only legal forward transitions. This is what guarantees an order can
# never reach DELIVERED without having passed through PICKED_UP.
_VALID_TRANSITIONS: dict[OrderStatus, set[OrderStatus]] = {
    OrderStatus.PENDING: {OrderStatus.ASSIGNED},
    OrderStatus.ASSIGNED: {OrderStatus.PICKED_UP},
    OrderStatus.PICKED_UP: {OrderStatus.DELIVERED},
    OrderStatus.DELIVERED: set(),
}


@dataclass
class Order:
    """A simulated order's current state."""

    order_id: str
    restaurant_id: str
    society_id: str
    status: OrderStatus = OrderStatus.PENDING
    assigned_driver: str | None = None
    pickup_time: float | None = None      # minutes, relative to assignment
    delivery_time: float | None = None    # minutes, relative to assignment
    pickup_route: list[str] = field(default_factory=list)    # driver -> restaurant
    delivery_route: list[str] = field(default_factory=list)  # restaurant -> society
    total_distance: float = 0.0
    total_travel_time: float = 0.0

    def transition(self, new_status: OrderStatus) -> None:
        """Advance the order's status, enforcing the PENDING -> ASSIGNED ->
        PICKED_UP -> DELIVERED order. Raises ValueError on any skip
        (e.g. PENDING -> DELIVERED or ASSIGNED -> DELIVERED)."""
        allowed = _VALID_TRANSITIONS[self.status]
        if new_status not in allowed:
            raise ValueError(
                f"Illegal order transition for {self.order_id}: "
                f"{self.status.value} -> {new_status.value}")
        self.status = new_status


def generate_orders(graph: Graph, num_orders: int, seed: int,
                    metric: str = "time", max_attempts: int = 20000
                    ) -> list[Order]:
    """Create ``num_orders`` orders, reproducibly, on real restaurant/society
    nodes that already have a valid route between them.

    Raises:
        ValueError: if ``num_orders`` valid, unique (restaurant, society)
            pairs cannot be found within ``max_attempts`` tries.
    """
    if num_orders <= 0:
        raise ValueError("num_orders must be positive.")

    rng = random.Random(seed)
    restaurants = sorted(nid for nid, loc in graph.locations.items()
                         if loc.kind == "Restaurant" and graph.is_connected_node(nid))
    societies = sorted(nid for nid, loc in graph.locations.items()
                       if loc.kind == "Society" and graph.is_connected_node(nid))
    if not restaurants or not societies:
        raise ValueError("Graph has no connected restaurant/society nodes.")

    orders: list[Order] = []
    seen_pairs: set[tuple[str, str]] = set()
    attempts = 0
    while len(orders) < num_orders and attempts < max_attempts:
        attempts += 1
        restaurant_id = rng.choice(restaurants)
        society_id = rng.choice(societies)
        pair = (restaurant_id, society_id)
        if pair in seen_pairs:
            continue
        if not dijkstra(graph, restaurant_id, society_id, metric).found:
            continue
        seen_pairs.add(pair)
        orders.append(Order(
            order_id=f"O{len(orders) + 1:04d}",
            restaurant_id=restaurant_id,
            society_id=society_id,
        ))

    if len(orders) < num_orders:
        raise ValueError(
            f"Could only generate {len(orders)}/{num_orders} orders with a "
            f"valid restaurant -> society route after {max_attempts} "
            f"attempts.")
    return orders
