import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { apiErrorMessage } from "../lib/api";
import type { Page, Params } from "../lib/resource-types";
import { Card, Empty, Loading } from "./ui";

export function Title({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">SMART CLASSROOM</p>
        <h2>{children}</h2>
      </div>
      {action}
    </div>
  );
}
export function ErrorBox({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="form-error" role="alert">
      {apiErrorMessage(error)}{" "}
      {retry && (
        <button type="button" className="secondary" onClick={retry}>
          Thử lại
        </button>
      )}
    </div>
  );
}
export function DetailData({ value }: { value: unknown }) {
  return <pre className="json-panel">{JSON.stringify(value, null, 2)}</pre>;
}
export type Column<T> = { label: string; render: (row: T) => ReactNode };
export function Table<T>({
  items,
  columns,
  rowKey,
}: {
  items: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
}) {
  return !items.length ? (
    <Empty />
  ) : (
    <div className="user-table-wrap">
      <table className="user-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.label}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.label}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Pager({
  page,
  size,
  total,
  change,
}: {
  page: number;
  size: number;
  total: number;
  change: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pagination">
      <span>
        {total} bản ghi · Trang {page}/{pages}
      </span>
      <div className="user-actions">
        <button
          className="secondary"
          disabled={page <= 1}
          onClick={() => change(page - 1)}
        >
          Trước
        </button>
        <button
          className="secondary"
          disabled={page >= pages}
          onClick={() => change(page + 1)}
        >
          Sau
        </button>
      </div>
    </div>
  );
}
export function Paged<T>({
  query,
  columns,
  rowKey,
  change,
}: {
  query: UseQueryResult<Page<T>, Error>;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  change: (page: number) => void;
}) {
  return query.isLoading ? (
    <Loading />
  ) : query.error ? (
    <ErrorBox
      error={query.error}
      retry={() => {
        void query.refetch();
      }}
    />
  ) : query.data ? (
    <Card>
      <Table items={query.data.items} columns={columns} rowKey={rowKey} />
      <Pager
        page={query.data.page}
        size={query.data.page_size}
        total={query.data.total}
        change={change}
      />
    </Card>
  ) : null;
}
export function useFilters(initial: Params = {}) {
  const [params, setParams] = useState<Params>({
    page: 1,
    page_size: 20,
    ...initial,
  });
  return {
    params,
    filter: (key: string, value: string) =>
      setParams((old) => ({ ...old, [key]: value, page: 1 })),
    go: (page: number) => setParams((old) => ({ ...old, page })),
  };
}
export function Filters({ children }: { children: ReactNode }) {
  return <div className="filters workspace-filters">{children}</div>;
}
export function Choice({
  label,
  value = "",
  options,
  onChange,
  empty = "Tất cả",
  disabled = false,
}: {
  label: string;
  value?: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  empty?: string;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{empty}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
export function useAction() {
  const queries = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  async function run(
    action: () => Promise<unknown>,
    message = "Đã lưu thay đổi.",
    invalidate = false,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await action();
      setMessage(message);
      if (invalidate) void queries.invalidateQueries();
    } catch (error) {
      setError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { run, busy, error, message, setMessage };
}
export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "password"
    | "number"
    | "checkbox"
    | "select"
    | "textarea"
    | "multiselect"
    | "datetime-local";
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  step?: string;
  hint?: string;
};
export function Editor({
  title,
  fields,
  initial = {},
  save,
  close,
  children,
  submitLabel = "Lưu",
}: {
  title: string;
  fields: Field[];
  initial?: Record<string, string>;
  save: (values: Record<string, string>) => Promise<unknown>;
  close: () => void;
  children?: ReactNode;
  submitLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const queries = useQueryClient();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="account-dialog wide-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="secondary"
          type="button"
          aria-label="Đóng"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </div>
      <form
        className="account-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError(undefined);
          try {
            await save(values);
            void queries.invalidateQueries();
            close();
          } catch (error) {
            setError(error);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {fields.map((field) => (
          <label key={field.name}>
            {field.label}
            {field.type === "select" || field.type === "multiselect" ? (
              <select
                name={field.name}
                required={field.required}
                multiple={field.type === "multiselect"}
                value={
                  field.type === "multiselect"
                    ? (values[field.name] || "").split(",").filter(Boolean)
                    : values[field.name] || ""
                }
                onChange={(event) =>
                  setValues({
                    ...values,
                    [field.name]:
                      field.type === "multiselect"
                        ? Array.from(event.target.selectedOptions)
                            .map((option) => option.value)
                            .join(",")
                        : event.target.value,
                  })
                }
              >
                {field.type !== "multiselect" && (
                  <option value="">Chọn…</option>
                )}
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea
                name={field.name}
                required={field.required}
                maxLength={field.maxLength}
                value={values[field.name] || ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              />
            ) : field.type === "checkbox" ? (
              <input
                name={field.name}
                type="checkbox"
                required={field.required}
                checked={values[field.name] === "true"}
                onChange={(event) =>
                  setValues({
                    ...values,
                    [field.name]: String(event.target.checked),
                  })
                }
              />
            ) : (
              <input
                name={field.name}
                type={field.type || "text"}
                required={field.required}
                min={field.min}
                max={field.max}
                minLength={field.minLength}
                maxLength={field.maxLength}
                pattern={field.pattern}
                step={field.step}
                autoComplete={
                  field.type === "password" ? "new-password" : undefined
                }
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              />
            )}{" "}
            {field.hint && <span className="muted small">{field.hint}</span>}
          </label>
        ))}
        {children}
        {Boolean(error) && <ErrorBox error={error} />}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            Hủy
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Đang lưu…" : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function Inspect({
  title,
  value,
  close,
}: {
  title: string;
  value: unknown;
  close: () => void;
}) {
  return (
    <Editor
      title={title}
      fields={[]}
      save={async () => {}}
      close={close}
      submitLabel="Đóng"
    >
      <DetailData value={value} />
    </Editor>
  );
}
