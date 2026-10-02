import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { requestPasswordResetAction } from "@/lib/actions/auth";

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-brand-600">PinkTree</div>
          <p className="text-sm text-gray-500 mt-1">Reset your password</p>
        </div>

        <div className="card p-6">
          <AuthForm action={requestPasswordResetAction} submitLabel="Send reset link">
            <div>
              <label className="label">Email</label>
              <input name="email" type="email" required className="input" placeholder="you@company.com" />
            </div>
            <p className="text-xs text-gray-500">
              If that email has an account, we&apos;ll send a link to reset your password.
            </p>
          </AuthForm>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          <Link href="/login" className="text-brand-600 hover:underline font-medium">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
