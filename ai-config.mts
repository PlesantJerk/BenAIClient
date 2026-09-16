import { defineConfig } from "./configsetup.mts";

export const GlobalConfig = defineConfig({
    projects: [
        {
            comment: "This is the client for the AI Web Site (benai.org)",
            name: "ch",
            path: "F:/Code/node/BenAIClient"
        },
        {
            comment: "This is the ai website server",
            name: "bs",
            path: "f:/code/git/Phone/ChatAblaze"
        },
        {
            comment: "quore project",
            name: "qf",
            path: "F:/Code/node/quore_projects/workflow_example/apps/vue_all"
        },
        {
            comment: "documentation/skills",
            name: "doc",
            path: "F:/Code/node/quore_projects/workflow_example/documentation"
        }
    ],
    at_file_extensions: ["cs", "ts", "js", "razor", "vue", "mts", "cjs"],
    exclude_directories: [".*", "node_modules"]
});