import { Show } from "@clerk/nextjs";
import CreatorWorkspace from "@/components/CreatorWorkspace";
import FeedbackForm from "@/components/FeedbackForm";
import LandingPage from "@/components/LandingPage";

/**
 * Dashboard shell: signed-in users get CreatorWorkspace, which owns the
 * render status polling loop (3s interval), loader state mapping, and
 * generate-button lockout while a render is in flight.
 */
export default function Home() {
  return (
    <>
      <Show when="signed-out">
        <LandingPage />
      </Show>
      <Show when="signed-in">
        <CreatorWorkspace />
      </Show>
      <FeedbackForm />
    </>
  );
}
