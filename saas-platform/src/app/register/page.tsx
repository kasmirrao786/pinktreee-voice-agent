import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { registerAction } from "@/lib/actions/auth";

export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-brand-600">PinkTree</div>
          <p className="text-sm text-gray-500 mt-1">Create your workspace</p>
        </div>

        <div className="card p-6">
          <AuthForm action={registerAction} submitLabel="Create account">
            <div>
              <label className="label">Company / workspace name</label>
              <input name="companyName" required className="input" placeholder="Acme Visa Consultants" />
            </div>
            <div>
              <label className="label">Email</label>
              <input name="email" type="email" required className="input" placeholder="you@company.com" />
            </div>
            <div>
              <label className="label">Password</label>
              <input name="password" type="password" required minLength={8} className="input" placeholder="At least 8 characters" />
            </div>
          </AuthForm>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-brand-600 hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
