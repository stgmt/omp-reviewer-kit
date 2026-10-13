import { registerReviewBatchGate } from './review-batch-extension.mjs';

export default function reviewGate(pi) {
  registerReviewBatchGate(pi);
}
