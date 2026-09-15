import * as React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";

interface Vehicle {
  id: string;
  driver: string;
  status: "active" | "idle" | "alert";
  lastStopEta: number;
}

async function fetchFleet(): Promise<Vehicle[]> {
  const res = await fetch("/api/fleet");
  if (!res.ok) throw new Error("failed to load fleet");
  return res.json();
}

export default function FleetDashboard() {
  const [vehicles, setVehicles] = React.useState<Vehicle[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<"all" | Vehicle["status"]>("all");

  React.useEffect(() => {
    let cancelled = false;
    fetchFleet()
      .then((data) => {
        if (!cancelled) setVehicles(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = React.useCallback(() => {
    setVehicles(null);
    setError(null);
    fetchFleet()
      .then(setVehicles)
      .catch((err) => setError(err.message));
  }, []);

  const visible = React.useMemo(() => {
    if (!vehicles) return [];
    if (filter === "all") return vehicles;
    return vehicles.filter((v) => v.status === filter);
  }, [vehicles, filter]);

  if (error) {
    return (
      <div className="p-6 text-red-600">
        Could not load fleet data: {error}
        <Button variant="outline" onClick={handleRefresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!vehicles) {
    return <div className="p-6">Loading fleet…</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Fleet Overview</h1>
        <Button onClick={handleRefresh}>Refresh</Button>
      </div>

      <div className="flex gap-2">
        {(["all", "active", "idle", "alert"] as const).map((s) => (
          <Button
            key={s}
            variant={filter === s ? "default" : "ghost"}
            size="sm"
            onClick={() => setFilter(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {visible.map((vehicle) => (
          <Card key={vehicle.id}>
            <CardHeader>
              <CardTitle>{vehicle.driver}</CardTitle>
              <Badge status={vehicle.status}>{vehicle.status}</Badge>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-500">
                ETA next stop: {vehicle.lastStopEta} min
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
