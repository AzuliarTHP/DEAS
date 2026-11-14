import { h3UploadCase, h3UploadCases, h3UploadTimeout, h3UploadTitle } from './Workbench.testHarness';
import { test } from 'vitest';

test.each(h3UploadCases.filter(c=>["ref2v"].includes(c.pipeline)))(h3UploadTitle,h3UploadCase,h3UploadTimeout);
