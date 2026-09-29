import { writeFileSync } from 'node:fs';
import { GRAPH_RESOURCE_PATH, createGraphResource } from './graph-resource.ts';

const resource = createGraphResource();
writeFileSync(GRAPH_RESOURCE_PATH, resource);

const { nodes, edges } = JSON.parse(resource) as { nodes: unknown[]; edges: unknown[] };
console.log(`resources/graph.json: ${nodes.length} workspaces, ${edges.length} dependencies`);
