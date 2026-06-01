"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ArchiveIcon, PlusIcon, SaveIcon } from "lucide-react";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

type Weekday = (typeof weekdays)[number];
type DmTeamId = Id<"attributionTeams">;

const weekdayLabels: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export function LeadGenSettingsPageClient() {
  const workers = useQuery(api.leadGen.workers.listWorkers, {
    includeInactive: true,
  });
  const teams = useQuery(api.leadGen.workers.listTeams, {
    includeInactive: true,
  });
  const schedules = useQuery(api.leadGen.workers.listWorkerSchedules, {});
  const settings = useQuery(api.leadGen.settings.getSettings, {});

  const createTeam = useMutation(api.leadGen.workers.createTeam);
  const archiveTeam = useMutation(api.leadGen.workers.archiveTeam);
  const updateWorkerProfile = useMutation(
    api.leadGen.workers.updateWorkerProfile,
  );
  const setWorkerSchedule = useMutation(api.leadGen.workers.setWorkerSchedule);
  const updateSettings = useMutation(api.leadGen.settings.updateSettings);

  const [newTeamName, setNewTeamName] = useState("");
  const [selectedWorkerId, setSelectedWorkerId] =
    useState<Id<"leadGenWorkers"> | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<Record<Weekday, string>>({
    monday: "0",
    tuesday: "0",
    wednesday: "0",
    thursday: "0",
    friday: "0",
    saturday: "0",
    sunday: "0",
  });
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rawExportMaxRows, setRawExportMaxRows] = useState("5000");
  const [correctionWindowMinutes, setCorrectionWindowMinutes] = useState("");
  const [duplicateDisplayMode, setDuplicateDisplayMode] = useState<
    "show_all" | "group_by_prospect"
  >("show_all");

  const activeTeams = useMemo(
    () => teams?.filter((team) => team.isActive) ?? [],
    [teams],
  );
  const selectedWorker =
    workers?.find((worker) => worker._id === selectedWorkerId) ?? workers?.[0];

  const scheduleByWorkerDay = useMemo(() => {
    const rows = new Map<string, number>();
    for (const schedule of schedules ?? []) {
      rows.set(
        `${schedule.workerId}:${schedule.weekday}`,
        schedule.scheduledHours,
      );
    }
    return rows;
  }, [schedules]);

  useEffect(() => {
    if (!selectedWorkerId && workers?.[0]) {
      setSelectedWorkerId(workers[0]._id);
    }
  }, [selectedWorkerId, workers]);

  useEffect(() => {
    if (!selectedWorker) return;

    const nextDraft = weekdays.reduce(
      (draft, weekday) => {
        draft[weekday] = String(
          scheduleByWorkerDay.get(`${selectedWorker._id}:${weekday}`) ?? 0,
        );
        return draft;
      },
      {} as Record<Weekday, string>,
    );
    setScheduleDraft(nextDraft);
  }, [scheduleByWorkerDay, selectedWorker]);

  useEffect(() => {
    if (!settings) return;
    const correctionWindow =
      "correctionWindowMinutes" in settings
        ? settings.correctionWindowMinutes
        : undefined;
    setRawExportMaxRows(String(settings.rawExportMaxRows));
    setCorrectionWindowMinutes(
      correctionWindow === undefined
        ? ""
        : String(correctionWindow),
    );
    setDuplicateDisplayMode(settings.duplicateDisplayMode);
  }, [settings]);

  const handleCreateTeam = async () => {
    const name = newTeamName.trim();
    if (!name) return;

    setSavingKey("create-team");
    try {
      await createTeam({ name });
      setNewTeamName("");
      toast.success("Team created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create team");
    } finally {
      setSavingKey(null);
    }
  };

  const handleArchiveTeam = async (teamId: DmTeamId) => {
    setSavingKey(`archive-team:${teamId}`);
    try {
      await archiveTeam({ teamId });
      toast.success("Team archived");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive team");
    } finally {
      setSavingKey(null);
    }
  };

  const handleWorkerActiveChange = async (
    workerId: Id<"leadGenWorkers">,
    teamId: DmTeamId | undefined,
    isActive: boolean,
  ) => {
    setSavingKey(`worker:${workerId}`);
    try {
      await updateWorkerProfile({
        workerId,
        ...(teamId ? { teamId } : {}),
        isActive,
      });
      toast.success("Worker updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update worker");
    } finally {
      setSavingKey(null);
    }
  };

  const handleWorkerTeamChange = async (
    workerId: Id<"leadGenWorkers">,
    isActive: boolean,
    teamValue: string,
  ) => {
    const teamId =
      teamValue === "none" ? undefined : (teamValue as DmTeamId);

    setSavingKey(`worker:${workerId}`);
    try {
      await updateWorkerProfile({
        workerId,
        ...(teamId ? { teamId } : {}),
        isActive,
      });
      toast.success("Worker team updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update team");
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveSchedule = async () => {
    if (!selectedWorker) return;

    setSavingKey("schedule");
    try {
      await Promise.all(
        weekdays.map((weekday) =>
          setWorkerSchedule({
            workerId: selectedWorker._id,
            weekday,
            scheduledHours: Number(scheduleDraft[weekday] || 0),
          }),
        ),
      );
      toast.success("Schedule saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save schedule");
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveRules = async () => {
    const rawLimit = Number(rawExportMaxRows);
    const correctionWindow = correctionWindowMinutes.trim()
      ? Number(correctionWindowMinutes)
      : undefined;

    setSavingKey("rules");
    try {
      await updateSettings({
        rawExportMaxRows: rawLimit,
        duplicateDisplayMode,
        ...(correctionWindow !== undefined
          ? { correctionWindowMinutes: correctionWindow }
          : {}),
      });
      toast.success("Rules saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save rules");
    } finally {
      setSavingKey(null);
    }
  };

  const isLoading =
    workers === undefined ||
    teams === undefined ||
    schedules === undefined ||
    settings === undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal">Lead Gen Ops</h1>
        <p className="text-sm text-muted-foreground">
          Manage worker access, team assignment, weekly schedules, and capture
          rules.
        </p>
      </div>

      <Tabs defaultValue="workers">
        <TabsList>
          <TabsTrigger value="workers">Workers</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="workers">
          <Card>
            <CardHeader>
              <CardTitle>Workers</CardTitle>
              <CardDescription>
                Lead generator profiles are synced from CRM users with the Lead
                Generator role.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workers.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="h-24 text-center text-muted-foreground"
                        >
                          No lead generators have been invited yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      workers.map((worker) => {
                        const teamValue =
                          worker.teamId &&
                          activeTeams.some((team) => team._id === worker.teamId)
                            ? (worker.teamId as DmTeamId)
                            : undefined;

                        return (
                          <TableRow key={worker._id}>
                            <TableCell>
                              <MemberIdentity identity={worker.avatar} />
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {worker.email}
                            </TableCell>
                            <TableCell>
                              <Select
                                value={teamValue ?? "none"}
                                onValueChange={(value) =>
                                  handleWorkerTeamChange(
                                    worker._id,
                                    worker.isActive,
                                    value,
                                  )
                                }
                                disabled={savingKey === `worker:${worker._id}`}
                              >
                                <SelectTrigger className="w-52">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    <SelectItem value="none">No team</SelectItem>
                                    {activeTeams.map((team) => (
                                      <SelectItem key={team._id} value={team._id}>
                                        {team.name}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <Switch
                                  checked={worker.isActive}
                                  onCheckedChange={(checked) =>
                                    handleWorkerActiveChange(
                                      worker._id,
                                      teamValue,
                                      checked,
                                    )
                                  }
                                  disabled={savingKey === `worker:${worker._id}`}
                                />
                                <Badge
                                  variant={
                                    worker.isActive ? "secondary" : "outline"
                                  }
                                >
                                  {worker.isActive ? "Active" : "Inactive"}
                                </Badge>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="teams">
          <Card>
            <CardHeader>
              <CardTitle>DM Teams</CardTitle>
              <CardDescription>
                Group workers for reporting and DM attribution.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={newTeamName}
                  onChange={(event) => setNewTeamName(event.target.value)}
                  placeholder="Team name"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleCreateTeam();
                    }
                  }}
                />
                <Button
                  type="button"
                  onClick={handleCreateTeam}
                  disabled={!newTeamName.trim() || savingKey === "create-team"}
                >
                  {savingKey === "create-team" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <PlusIcon data-icon="inline-start" />
                  )}
                  Create Team
                </Button>
              </div>

              {isLoading ? (
                <Skeleton className="h-52 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teams.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="h-24 text-center text-muted-foreground"
                        >
                          No DM teams have been created.
                        </TableCell>
                      </TableRow>
                    ) : (
                      teams.map((team) => (
                        <TableRow key={team._id}>
                          <TableCell className="font-medium">
                            {team.name}
                          </TableCell>
                          <TableCell>
                            <Badge variant={team.isActive ? "secondary" : "outline"}>
                              {team.isActive ? "Active" : "Archived"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {team.isActive ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => handleArchiveTeam(team._id)}
                                disabled={
                                  savingKey === `archive-team:${team._id}`
                                }
                              >
                                {savingKey === `archive-team:${team._id}` ? (
                                  <Spinner data-icon="inline-start" />
                                ) : (
                                  <ArchiveIcon data-icon="inline-start" />
                                )}
                                Archive
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="schedules">
          <Card>
            <CardHeader>
              <CardTitle>Weekly Schedules</CardTitle>
              <CardDescription>
                Store expected hours by worker and weekday for productivity
                reporting.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {isLoading ? (
                <Skeleton className="h-52 w-full" />
              ) : workers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Invite a lead generator before setting schedules.
                </p>
              ) : (
                <>
                  <Field>
                    <FieldLabel>Worker</FieldLabel>
                    <Select
                      value={selectedWorker?._id}
                      onValueChange={(value) =>
                        setSelectedWorkerId(value as Id<"leadGenWorkers">)
                      }
                    >
                      <SelectTrigger className="w-80 max-w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {workers.map((worker) => (
                            <SelectItem key={worker._id} value={worker._id}>
                              {worker.displayName ?? worker.email}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
                    {weekdays.map((weekday) => (
                      <Field key={weekday}>
                        <FieldLabel>{weekdayLabels[weekday]}</FieldLabel>
                        <Input
                          type="number"
                          min={0}
                          max={24}
                          step={0.25}
                          value={scheduleDraft[weekday]}
                          onChange={(event) =>
                            setScheduleDraft((draft) => ({
                              ...draft,
                              [weekday]: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </div>

                  <div>
                    <Button
                      type="button"
                      onClick={handleSaveSchedule}
                      disabled={savingKey === "schedule"}
                    >
                      {savingKey === "schedule" ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <SaveIcon data-icon="inline-start" />
                      )}
                      Save Schedule
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules">
          <Card>
            <CardHeader>
              <CardTitle>Capture Rules</CardTitle>
              <CardDescription>
                Tenant-wide defaults for correction windows, exports, and
                duplicate display.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-56 w-full" />
              ) : (
                <FieldGroup>
                  <Field>
                    <FieldLabel>Correction window minutes</FieldLabel>
                    <Input
                      type="number"
                      min={0}
                      max={10080}
                      value={correctionWindowMinutes}
                      onChange={(event) =>
                        setCorrectionWindowMinutes(event.target.value)
                      }
                      placeholder="No worker correction window"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Raw export max rows</FieldLabel>
                    <Input
                      type="number"
                      min={1}
                      max={50000}
                      value={rawExportMaxRows}
                      onChange={(event) =>
                        setRawExportMaxRows(event.target.value)
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Duplicate display</FieldLabel>
                    <Select
                      value={duplicateDisplayMode}
                      onValueChange={(value) =>
                        setDuplicateDisplayMode(
                          value as "show_all" | "group_by_prospect",
                        )
                      }
                    >
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="show_all">
                            Show every submission
                          </SelectItem>
                          <SelectItem value="group_by_prospect">
                            Group by prospect
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div>
                    <Button
                      type="button"
                      onClick={handleSaveRules}
                      disabled={savingKey === "rules"}
                    >
                      {savingKey === "rules" ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <SaveIcon data-icon="inline-start" />
                      )}
                      Save Rules
                    </Button>
                  </div>
                </FieldGroup>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
