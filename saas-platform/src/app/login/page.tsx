import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { loginAction } from "@/lib/actions/auth";

export default function LoginPage({ searchParams }: { searchParams: { deactivated?: string } }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-brand-600">PinkTree</div>
          <p className="text-sm text-gray-500 mt-1">Sign in to your workspace</p>
        </div>

        {searchParams?.deactivated && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
            Your account has been deactivated. Contact support for help.
          </p>
        )}

        <div className="card p-6">
          <AuthForm action={loginAction} submitLabel="Sign in">
            <div>
              <label className="label">Email</label>
              <input name="email" type="email" required className="input" placeholder="you@company.com" />
            </div>
            <div>
              <label className="label">Password</label>
              <input name="password" type="password" required className="input" placeholder="••••••••" />
            </div>
            <div className="text-right">
              <Link href="/reset-password" className="text-sm text-brand-600 hover:underline">
                Forgot password?
              </Link>
            </div>
          </AuthForm>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-brand-600 hover:underline font-medium">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
