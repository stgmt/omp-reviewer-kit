#!/usr/bin/env node
import { PluginInstallerService } from '../src/application/installer-service.mjs';

const targetDir = process.argv[2] || process.cwd();
const installer = new PluginInstallerService();

try {
  const result = await installer.setup(targetDir);
  if (result.success) {
    console.log(result.message);
    process.exit(0);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`Error: ${error.message || String(error)}`);
  process.exit(1);
}
