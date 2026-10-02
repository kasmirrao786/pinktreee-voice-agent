import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { confirmPasswordResetAction } from "@/lib/actions/auth";

export default function ConfirmResetPasswordPage({ searchParams }: { searchParams: { token?: string } }) {
  const token = searchParams?.token || "";

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-brand-600">PinkTree</div>
          <p className="text-sm text-gray-500 mt-1">Choose a new password</p>
        </div>

        <div className="card p-6">
          {token ? (
            <AuthForm action={confirmPasswordResetAction} submitLabel="Set new password">
              <input type="hidden" name="token" value={token} />
              <div>
                <label className="label">New password</label>
                <input name="newPassword" type="password" required minLength={8} className="input" placeholder="At least 8 characters" />
              </div>
            </AuthForm>
          ) : (
            <p className="text-sm text-red-600">
              This reset link is missing its token. Request a new one from the{" "}
              <Link href="/reset-password" className="underline">
                reset password
              </Link>{" "}
              page.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
