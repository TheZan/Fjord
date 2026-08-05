/**
 * Which top-level screen is showing. Introduced because every feature so far
 * was appended to one scrolling page — the dashboard's workspace cards and
 * the flat "all repositories" list rendered the same repos twice, one above
 * the other. They're alternate views of the same data, not two sections.
 */
export type View = "overview" | "repositories";
