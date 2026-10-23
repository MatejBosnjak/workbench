import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { statusColors, type Task, type TaskDetail } from "@shared/tasks";
import { Box } from "./Box";

/**
 * Task details by id, shared by the card's status select and the Productive section. Shows the last fetch at once
 * while a fresh one loads; a write's result replaces it for both.
 */
const cache = new Map<string, TaskDetail>();
const listeners = new Set<() => void>();
const put = (id: string, d: TaskDetail) => {
  cache.set(id, d);
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (
  listeners.add(l),
  () => void listeners.delete(l)
);

const clean = (e: unknown) =>
  (e as Error).message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );

/** The task's detail, fetched fresh each time the task is shown. */
function useTaskDetail(taskId: string): {
  detail: TaskDetail | null;
  error: string | null;
} {
  const detail = useSyncExternalStore(
    subscribe,
    () => cache.get(taskId) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    window.workbench.tasks.detail(taskId).then(
      (d) => put(taskId, d),
      (e) => live && setError(clean(e)),
    );
    return () => {
      live = false;
    };
  }, [taskId]);
  return { detail, error };
}

/** Runs a write (which asks for a confirm in main); null means it was cancelled. */
function useWrite(taskId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = async (key: string, run: () => Promise<TaskDetail | null>) => {
    setBusy(key);
    setError(null);
    try {
      const d = await run();
      if (d) put(taskId, d);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, write };
}

/** The card's status line: a select over the task's workflow, in Productive's colours. Plain text until the statuses load. */
export function StatusSelect({ task }: { task: Task }) {
  const { detail } = useTaskDetail(task.id);
  const { busy, error, write } = useWrite(task.id);
  const current = detail?.statuses.find((s) => s.id === detail.statusId);
  const color = current
    ? statusColors(current)[1]
    : statusColors({ colorId: task.statusColorId })[1];
  const closed = (current?.categoryId ?? task.statusCategory) === 3;
  return (
    <span className="status-select" style={{ color }}>
      <span aria-hidden="true">
        {(current?.categoryId ?? task.statusCategory) === 1 ? "○" : "●"}
      </span>
      {detail?.statuses.length ? (
        <span className="ss-field">
          <select
            aria-label="Status"
            value={detail.statusId}
            disabled={!!busy}
            className={closed ? "closed" : ""}
            onChange={(e) =>
              void write("status", () =>
                window.workbench.tasks.setStatus(task.id, e.target.value),
              )
            }
          >
            {detail.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </span>
      ) : (
        <span>{task.statusName}</span>
      )}
      {busy && <span className="faint">saving…</span>}
      {error && <span className="bad-text">{error}</span>}
    </span>
  );
}

/** Plain text with its URLs as links that open in the browser. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a
            key={i}
            href={p}
            onClick={(e) => (
              e.preventDefault(),
              void window.workbench.openExternal(p)
            )}
          >
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** The task as Productive has it: description and to-dos. Every write asks first. */
export function TaskDetails({
  taskId,
  withTitle = false,
}: {
  taskId: string;
  withTitle?: boolean;
}) {
  const { detail, error: loadError } = useTaskDetail(taskId);
  const { busy, error, write } = useWrite(taskId);
  const open = detail?.todos.filter((t) => !t.closed).length ?? 0;

  return (
    <Box title="Productive" className="peek task-details">
      {!detail && !loadError && <span className="faint">loading…</span>}
      {(loadError || error) && (
        <span className="bad-text">{loadError || error}</span>
      )}
      {detail && (
        <>
          {withTitle && (
            <>
              <StatusSelect task={detail.task} />
              <h2 className="peek-title">
                <a
                  href={detail.task.url}
                  onClick={(e) => (
                    e.preventDefault(),
                    void window.workbench.openExternal(detail.task.url)
                  )}
                >
                  {detail.task.title}
                </a>
              </h2>
            </>
          )}

          <div className="peek-sub">description</div>
          {detail.description ? (
            <div className="td-desc">
              <Linked text={detail.description} />
            </div>
          ) : (
            <span className="faint">none</span>
          )}

          <div className="peek-sub">
            to-dos{" "}
            {detail.todos.length > 0 && (
              <span className="faint">
                {detail.todos.length - open}/{detail.todos.length}
              </span>
            )}
          </div>
          {detail.todos.length === 0 && <span className="faint">none</span>}
          {detail.todos.map((t) => (
            <label
              key={t.id}
              className={`td-todo${t.closed ? " done" : ""}${busy === `t:${t.id}` ? " busy" : ""}`}
            >
              <input
                type="checkbox"
                checked={t.closed}
                disabled={!!busy}
                onChange={() =>
                  void write(`t:${t.id}`, () =>
                    window.workbench.tasks.setTodo(taskId, t.id, !t.closed),
                  )
                }
              />
              <span>
                <Linked text={t.text} />
              </span>
            </label>
          ))}
        </>
      )}
    </Box>
  );
}
