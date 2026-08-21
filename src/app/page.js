import { SignedIn, SignedOut } from "@clerk/nextjs";
import CreatorWorkspace from "@/components/CreatorWorkspace";
import LandingPage from "@/components/LandingPage";

/**
 * Dashboard shell: signed-in users get CreatorWorkspace, which owns the
 * Shotstack status polling loop (3s interval), loader state mapping, and
 * generate-button lockout while a render is in flight.
 */
export default function Home() {
  return (
    <>
      <SignedOut>
        <LandingPage />
      </SignedOut>
      <SignedIn>
        <CreatorWorkspace />
      </SignedIn>
    </>
  );
}
