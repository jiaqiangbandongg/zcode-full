import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackSubmitForm } from "@/feedback/FeedbackSubmitForm.js";
import {
  getFeedbackSubmissionJob,
  getFeedbackSubmissionJobsSnapshot,
} from "@/feedback/feedbackSubmissionJob.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 仅用于隔离窗口：真实表单/helper/job 调用内存服务，不创建真实工单或读取本机日志。
const calls = { create: 0, prepare: 0, upload: [], cleanup: 0 };
const createInputs = [];
let rejectNextCreate = false;
const feedbackService = {
  getDeviceSnapshot: async () => ({}),
  create: async (input) => {
    createInputs.push(structuredClone(input));
    calls.create += 1;
    if (rejectNextCreate) {
      rejectNextCreate = false;
      throw new Error("E2E_FEEDBACK_CREATE_FAILED");
    }
    return { id: `E2E_FEEDBACK_${calls.create}` };
  },
  prepareCompactLogArchive: async () => {
    calls.prepare += 1;
    return { path: "E2E_SYNTHETIC_LOG.zip", size: 4 };
  },
  uploadAttachmentWithProgress: async (_id, kind) => {
    calls.upload.push(kind);
    return {};
  },
  cleanupPreparedLogArchive: async () => {
    calls.cleanup += 1;
  },
  onDynamicUploadProgress: () => () => ({ dispose() {} }),
  cancelCreate: async () => {},
};
const container = document.createElement("main");
document.body.append(container);
const root = createRoot(container);
let generation = 0;
function mount(submissionJobId) {
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        TabStoreProvider,
        null,
        createElement(FeedbackSubmitForm, {
          key: ++generation,
          feedbackService,
          platform: {},
          submissionJobId,
          onSubmitted() {},
          onViewTickets() {},
          onCancel() {},
        }),
      ),
    ),
  );
}
const fixture = {
  failNextCreate() {
    rejectNextCreate = true;
  },
  restore(jobId) {
    mount(jobId);
  },
  snapshot() {
    return {
      calls,
      createInputs,
      jobs: getFeedbackSubmissionJobsSnapshot().map((state) => ({
        id: state.id,
        status: state.status,
        includeLogs: getFeedbackSubmissionJob(state.id)?.formDraft.includeLogs,
      })),
    };
  },
};
window.feedbackSubmitFixture = fixture;
mount();
