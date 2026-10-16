import {
  capabilityEdges,
  capabilityGroups,
  capabilityNodes,
} from "@/data/productCapabilityMap.js";

const capabilityNodeById = new Map(
  capabilityNodes.map((node) => [node.id, node]),
);
const capabilityGroupById = new Map(
  capabilityGroups.map((group) => [group.id, group]),
);
const capabilityGroupOrder = new Map(
  capabilityGroups.map((group, index) => [group.id, index]),
);

function buildGroupRelationWeights(systemId: string) {
  const systemGroups = capabilityGroups.filter(
    (group) => group.systemId === systemId,
  );
  const weights = new Map(
    systemGroups.map((group) => [group.id, new Map<string, number>()]),
  );
  for (const edge of capabilityEdges) {
    const sourceGroupId = capabilityNodeById.get(edge.source)?.groupId;
    const targetGroupId = capabilityNodeById.get(edge.target)?.groupId;
    if (
      !sourceGroupId ||
      !targetGroupId ||
      sourceGroupId === targetGroupId ||
      capabilityGroupById.get(sourceGroupId)?.systemId !== systemId ||
      capabilityGroupById.get(targetGroupId)?.systemId !== systemId
    ) {
      continue;
    }
    const sourceWeights = weights.get(sourceGroupId);
    const targetWeights = weights.get(targetGroupId);
    sourceWeights?.set(
      targetGroupId,
      (sourceWeights.get(targetGroupId) ?? 0) + 1,
    );
    targetWeights?.set(
      sourceGroupId,
      (targetWeights.get(sourceGroupId) ?? 0) + 1,
    );
  }
  return weights;
}

function getWeightedDegree(
  groupId: string,
  relationWeights: Map<string, Map<string, number>>,
) {
  return [...(relationWeights.get(groupId)?.values() ?? [])].reduce(
    (sum, weight) => sum + weight,
    0,
  );
}

function compareGroupIds(
  leftId: string,
  rightId: string,
  relationWeights: Map<string, Map<string, number>>,
  currentId?: string,
) {
  const currentWeights = currentId
    ? relationWeights.get(currentId)
    : undefined;
  const directDifference =
    (currentWeights?.get(rightId) ?? 0) -
    (currentWeights?.get(leftId) ?? 0);
  if (directDifference !== 0) {
    return directDifference;
  }
  const degreeDifference =
    getWeightedDegree(rightId, relationWeights) -
    getWeightedDegree(leftId, relationWeights);
  if (degreeDifference !== 0) {
    return degreeDifference;
  }
  return (
    (capabilityGroupOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
    (capabilityGroupOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function orderGroupsByRelations(systemId: string) {
  const systemGroupIds = capabilityGroups
    .filter((group) => group.systemId === systemId)
    .map((group) => group.id);
  const relationWeights = buildGroupRelationWeights(systemId);
  const remaining = new Set(systemGroupIds);
  const ordered: string[] = [];

  while (remaining.size > 0) {
    const seed = [...remaining].sort((leftId, rightId) =>
      compareGroupIds(leftId, rightId, relationWeights),
    )[0];
    if (!seed) {
      break;
    }
    remaining.delete(seed);
    const queue = [seed];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) {
        continue;
      }
      ordered.push(currentId);
      const neighbors = [...(relationWeights.get(currentId)?.keys() ?? [])]
        .filter((groupId) => remaining.has(groupId))
        .sort((leftId, rightId) =>
          compareGroupIds(
            leftId,
            rightId,
            relationWeights,
            currentId,
          ),
        );
      for (const neighborId of neighbors) {
        remaining.delete(neighborId);
        queue.push(neighborId);
      }
    }
  }

  return ordered;
}
