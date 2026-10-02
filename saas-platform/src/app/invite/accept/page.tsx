import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { acceptInviteAction } from "@/lib/actions/team";

export default function AcceptInvitePage({ searchParams }: { searchParams: { token?: string } }) {
  const token = searchParams?.token || "";

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-brand-600">PinkTree</div>
          <p className="text-sm text-gray-500 mt-1">You&apos;ve been invited to join a workspace</p>
        </div>

        <div className="card p-6">
          {token ? (
            <AuthForm action={acceptInviteAction} submitLabel="Join workspace">
              <input type="hidden" name="token" value={token} />
              <div>
                <label className="label">Set a password</label>
                <input name="password" type="password" required minLength={8} className="input" placeholder="At least 8 characters" />
              </div>
            </AuthForm>
          ) : (
            <p className="text-sm text-red-600">
              This invite link is missing its token. Ask whoever invited you to send a new one, or{" "}
              <Link href="/login" className="underline">
                sign in
              </Link>{" "}
              if you already have an account.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
