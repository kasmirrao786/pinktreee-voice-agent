"use client";

export default function RoleSelect({
  action,
  defaultValue,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaultValue: string;
}) {
  return (
    <form action={action}>
      <select
        name="role"
        defaultValue={defaultValue}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="input py-1 text-xs"
      >
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
    </form>
  );
}
