"use client";

import { useActionState, useEffect, useRef, useTransition, type FormEvent, type ReactNode } from "react";
import type { ActionState } from "@/lib/action-result";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

function SubmitButton({
  label,
  variant,
  pending,
}: {
  label: string;
  variant: "primary" | "danger" | "subtle";
  pending: boolean;
}) {
  const styles = {
    primary: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
    danger: "text-red-600 hover:bg-red-50 dark:hover:bg-red-950",
    subtle: "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900",
  }[variant];
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${styles}`}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

/** A form bound to a server action, showing its pending state and any returned error. */
export function ActionForm({
  action,
  children,
  submitLabel,
  variant = "primary",
  className = "flex flex-wrap items-end gap-3",
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  variant?: "primary" | "danger" | "subtle";
  className?: string;
}) {
  const [state, formAction, actionPending] = useActionState(action, null);
  const [transitionPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // React resets a <form action> after every submission, which would wipe the user's input when the
  // server rejects it. Submit manually instead, and clear the form only after a success.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className={className}>
      {children}
      <SubmitButton label={submitLabel} variant={variant} pending={actionPending || transitionPending} />
      {state?.error && (
        <p role="alert" className="w-full text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="w-full text-sm text-emerald-700">
          {state.ok}
        </p>
      )}
    </form>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required = true,
  hint,
  wide = false,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${wide ? "w-full" : ""}`}>
      <span className="font-medium">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        step={type === "number" ? "any" : undefined}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
      />
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}
