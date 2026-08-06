import fs from "node:fs";

const [tag, repository] = process.argv.slice(2);

if (!tag || !repository) {
  throw new Error("Usage: node scripts/prepare-release.mjs <tag> <owner/repository>");
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must look like v1.2.3 or v1.2.3-beta.1; received ${tag}.`);
}

if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
  throw new Error(`GitHub repository must look like owner/repository; received ${repository}.`);
}

const packagePath = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  throw new Error(`Tag ${tag} does not match package.json version ${packageJson.version}; expected ${expectedTag}.`);
}

const repositoryUrl = `git+https://github.com/${repository}.git`;
packageJson.repository = {
  type: "git",
  url: repositoryUrl,
};
packageJson.bugs = {
  url: `https://github.com/${repository}/issues`,
};
packageJson.homepage = `https://github.com/${repository}#readme`;

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Prepared ${packageJson.name}@${packageJson.version} for ${repositoryUrl}.`);
