import { beforeEach, describe, expect, it } from "vitest";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";

function resetFeedbackStore() {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    submissionJobId: null,
    selectedTicketId: null,
  });
}

describe("feedback store", () => {
  beforeEach(() => {
    resetFeedbackStore();
  });

  it("keeps feature request and issue report dialogs mutually exclusive", () => {
    useFeedbackStore.getState().openFeatureRequest();
    expect(useFeedbackStore.getState()).toMatchObject({
      open: false,
      featureRequestOpen: true,
    });

    useFeedbackStore.getState().openSubmit({ includeLogs: true });
    expect(useFeedbackStore.getState()).toMatchObject({
      open: true,
      featureRequestOpen: false,
      tab: "submit",
    });

    useFeedbackStore.getState().openFeatureRequest();
    expect(useFeedbackStore.getState()).toMatchObject({
      open: false,
      featureRequestOpen: true,
    });
  });

  it("always opens issue reports as a new form instead of reusing a background submission", () => {
    useFeedbackStore.getState().openSubmissionJob("feedback-job-a");
    expect(useFeedbackStore.getState()).toMatchObject({
      open: true,
      tab: "submit",
      submissionJobId: "feedback-job-a",
    });

    useFeedbackStore.getState().openSubmit({ includeLogs: true });
    expect(useFeedbackStore.getState()).toMatchObject({
      open: true,
      tab: "submit",
      submissionJobId: null,
      submitDraft: { includeLogs: true },
    });
  });

  it("opens each background submission by its own job id", () => {
    useFeedbackStore.getState().openSubmissionJob("feedback-job-a");
    expect(useFeedbackStore.getState().submissionJobId).toBe("feedback-job-a");

    useFeedbackStore.getState().openSubmissionJob("feedback-job-b");
    expect(useFeedbackStore.getState().submissionJobId).toBe("feedback-job-b");
  });
});
