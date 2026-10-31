package dfsm

import (
	"fmt"
	"sort"
	"strings"
)

type MatchedTransition struct {
	SourceNode *StateDefinition
	Edge       TransitionDefinition
	SourcePath string
}

type AppliedTransition struct {
	TargetPath     string
	NextStateValue StateValue
	ExitEffects    []string
	EntryEffects   []string
}

type subtreeEntry struct {
	subValue     *StateValue
	entryEffects []string
}

func getNodeByPath(m *MachineDefinition, dotPath string) *StateDefinition {
	if dotPath == "" {
		return nil
	}
	parts := strings.Split(dotPath, ".")
	currentMap := m.States
	var found *StateDefinition
	for _, part := range parts {
		if part == "" {
			continue
		}
		s, ok := currentMap[part]
		if !ok {
			return nil
		}
		found = s
		currentMap = s.States
	}
	return found
}

func enterSubtree(node *StateDefinition) subtreeEntry {
	entryEffects := append([]string{}, node.Entry...)

	if !node.IsCompound() && !node.IsParallel() {
		return subtreeEntry{subValue: nil, entryEffects: entryEffects}
	}

	if node.IsCompound() {
		if node.Initial == "" {
			return subtreeEntry{subValue: nil, entryEffects: entryEffects}
		}
		child, ok := node.States[node.Initial]
		if !ok {
			return subtreeEntry{subValue: nil, entryEffects: entryEffects}
		}
		enteredChild := enterSubtree(child)
		entryEffects = append(entryEffects, enteredChild.entryEffects...)

		var val StateValue
		if enteredChild.subValue == nil {
			val = Leaf(child.Id)
		} else {
			val = SingleNested(child.Id, *enteredChild.subValue)
		}
		return subtreeEntry{subValue: &val, entryEffects: entryEffects}
	}

	// Parallel: enter each region
	parallelMap := make(map[string]StateValue, len(node.States))
	for k, region := range node.States {
		enteredRegion := enterSubtree(region)
		entryEffects = append(entryEffects, enteredRegion.entryEffects...)
		if enteredRegion.subValue != nil {
			parallelMap[k] = *enteredRegion.subValue
		} else {
			parallelMap[k] = Leaf(k)
		}
	}
	res := CompoundState(parallelMap)
	return subtreeEntry{subValue: &res, entryEffects: entryEffects}
}

func ResolveInitialState(m *MachineDefinition) (StateValue, []string) {
	if strings.EqualFold(m.Type, "parallel") {
		rootMap := make(map[string]StateValue, len(m.States))
		var effects []string
		for k, s := range m.States {
			if k == "error" {
				continue
			}
			entered := enterSubtree(s)
			effects = append(effects, entered.entryEffects...)
			if entered.subValue != nil {
				rootMap[k] = *entered.subValue
			} else {
				rootMap[k] = Leaf(k)
			}
		}
		return CompoundState(rootMap), effects
	}

	initNode := m.States[m.Initial]
	enteredRoot := enterSubtree(initNode)
	var stateVal StateValue
	if enteredRoot.subValue == nil {
		stateVal = Leaf(initNode.Id)
	} else {
		stateVal = SingleNested(initNode.Id, *enteredRoot.subValue)
	}
	return stateVal, enteredRoot.entryEffects
}

func GetActiveLeafPaths(m *MachineDefinition, sv StateValue) []string {
	return getActiveLeafPathsInternal(m, sv, "")
}

func getActiveLeafPathsInternal(m *MachineDefinition, sv StateValue, parentPath string) []string {
	if !sv.IsCompound {
		leaf := sv.Atomic
		if parentPath == "" {
			return []string{leaf}
		}
		return []string{parentPath + "." + leaf}
	}

	var leaves []string
	for key, childVal := range sv.Compound {
		currentPath := key
		if parentPath != "" {
			currentPath = parentPath + "." + key
		}
		node := getNodeByPath(m, currentPath)

		if node != nil && node.IsParallel() && childVal.IsCompound {
			for regKey, regVal := range childVal.Compound {
				regPath := currentPath + "." + regKey
				regNode := getNodeByPath(m, regPath)
				if regNode != nil && !regNode.IsCompound() && !regNode.IsParallel() {
					leaves = append(leaves, regPath)
				} else if !regVal.IsCompound {
					leaves = append(leaves, regPath+"."+regVal.Atomic)
				} else {
					leaves = append(leaves, getActiveLeafPathsInternal(m, regVal, regPath)...)
				}
			}
		} else {
			leaves = append(leaves, getActiveLeafPathsInternal(m, childVal, currentPath)...)
		}
	}
	return leaves
}

func ResolveTransitionsForEvent(m *MachineDefinition, sv StateValue, eventName string) []MatchedTransition {
	if !sv.IsCompound {
		if rootChild, ok := m.States[sv.Atomic]; ok {
			return searchInSubtree(m, rootChild, nil, eventName, rootChild.Id)
		}
		return nil
	}

	var results []MatchedTransition
	for key, childVal := range sv.Compound {
		rootChild, ok := m.States[key]
		if !ok {
			continue
		}
		var normalized *StateValue
		if rootChild.IsCompound() || rootChild.IsParallel() {
			normalized = &childVal
		}
		results = append(results, searchInSubtree(m, rootChild, normalized, eventName, rootChild.Id)...)
	}
	return results
}

func searchInSubtree(m *MachineDefinition, node *StateDefinition, subVal *StateValue, eventName string, currentPath string) []MatchedTransition {
	if !node.IsCompound() && !node.IsParallel() {
		if list, ok := node.On[eventName]; ok && len(list) > 0 {
			return []MatchedTransition{{SourceNode: node, Edge: list[0], SourcePath: currentPath}}
		}
		return nil
	}

	if node.IsCompound() {
		if subVal != nil && !subVal.IsCompound {
			if child, ok := node.States[subVal.Atomic]; ok {
				childMatches := searchInSubtree(m, child, nil, eventName, currentPath+"."+child.Id)
				if len(childMatches) > 0 {
					return childMatches
				}
			}
		} else if subVal != nil && subVal.IsCompound {
			for k, v := range subVal.Compound {
				if child, ok := node.States[k]; ok {
					childMatches := searchInSubtree(m, child, &v, eventName, currentPath+"."+child.Id)
					if len(childMatches) > 0 {
						return childMatches
					}
				}
			}
		}

		// Bubble up to compound state
		if list, ok := node.On[eventName]; ok && len(list) > 0 {
			return []MatchedTransition{{SourceNode: node, Edge: list[0], SourcePath: currentPath}}
		}
		return nil
	}

	// Parallel: search regions
	var regionMatches []MatchedTransition
	var regionMap map[string]StateValue
	if subVal != nil && subVal.IsCompound {
		regionMap = subVal.Compound
	} else {
		regionMap = make(map[string]StateValue)
	}

	for k, region := range node.States {
		rVal, has := regionMap[k]
		var normalized *StateValue
		if has && (region.IsCompound() || region.IsParallel()) {
			normalized = &rVal
		}
		regionMatches = append(regionMatches, searchInSubtree(m, region, normalized, eventName, currentPath+"."+region.Id)...)
	}

	if len(regionMatches) > 0 {
		return regionMatches
	}

	// Bubble to parallel state
	if list, ok := node.On[eventName]; ok && len(list) > 0 {
		return []MatchedTransition{{SourceNode: node, Edge: list[0], SourcePath: currentPath}}
	}
	return nil
}

func resolveTargetPath(m *MachineDefinition, sourcePath string, targetRef string) string {
	if targetRef == "" {
		return sourcePath
	}
	targetRef = strings.TrimPrefix(targetRef, "#")

	if _, ok := m.States[targetRef]; ok {
		return targetRef
	}

	parts := strings.Split(sourcePath, ".")
	for i := len(parts) - 1; i >= 0; i-- {
		prefix := strings.Join(parts[:i], ".")
		candidate := targetRef
		if prefix != "" {
			candidate = prefix + "." + targetRef
		}
		if getNodeByPath(m, candidate) != nil {
			return candidate
		}
	}

	if found := findPathRecursive(m.States, targetRef, ""); found != "" {
		return found
	}
	return targetRef
}

func findPathRecursive(states map[string]*StateDefinition, targetRef string, prefix string) string {
	for k, v := range states {
		currentPath := k
		if prefix != "" {
			currentPath = prefix + "." + k
		}
		if k == targetRef || currentPath == targetRef {
			return currentPath
		}
		if len(v.States) > 0 {
			if found := findPathRecursive(v.States, targetRef, currentPath); found != "" {
				return found
			}
		}
	}
	return ""
}

func ApplyTargetTransition(m *MachineDefinition, currentState StateValue, sourcePath string, targetRef string) AppliedTransition {
	targetPath := resolveTargetPath(m, sourcePath, targetRef)
	targetNode := getNodeByPath(m, targetPath)
	if targetNode == nil {
		panic(fmt.Sprintf("cannot resolve target state '%s' from '%s'", targetRef, sourcePath))
	}

	srcParts := strings.Split(sourcePath, ".")
	tgtParts := strings.Split(targetPath, ".")

	commonLen := 0
	maxCommon := len(srcParts)
	if len(tgtParts) < maxCommon {
		maxCommon = len(tgtParts)
	}
	maxCommon--
	for commonLen < maxCommon && srcParts[commonLen] == tgtParts[commonLen] {
		commonLen++
	}

	lcaParts := tgtParts[:commonLen]
	exitingRoot := sourcePath
	if len(srcParts) > commonLen {
		exitingRoot = strings.Join(srcParts[:commonLen+1], ".")
	}

	exitEffects := collectExitEffects(m, currentState, exitingRoot)

	var entryEffects []string
	for i := commonLen; i < len(tgtParts)-1; i++ {
		ancPath := strings.Join(tgtParts[:i+1], ".")
		if anc := getNodeByPath(m, ancPath); anc != nil {
			entryEffects = append(entryEffects, anc.Entry...)
		}
	}

	enteredTarget := enterSubtree(targetNode)
	entryEffects = append(entryEffects, enteredTarget.entryEffects...)

	var builtBranch StateValue
	if enteredTarget.subValue == nil {
		builtBranch = Leaf(targetNode.Id)
	} else {
		builtBranch = SingleNested(targetNode.Id, *enteredTarget.subValue)
	}

	for i := len(tgtParts) - 2; i >= commonLen; i-- {
		ancKey := tgtParts[i]
		ancPath := strings.Join(tgtParts[:i+1], ".")
		ancNode := getNodeByPath(m, ancPath)

		if ancNode != nil && ancNode.IsParallel() {
			existingRegions := extractSubStateMap(currentState, ancPath)
			regionKey := tgtParts[i+1]
			regionVal := builtBranch
			if builtBranch.IsCompound {
				if r, ok := builtBranch.Compound[regionKey]; ok {
					regionVal = r
				}
			}
			existingRegions[regionKey] = regionVal
			builtBranch = SingleNested(ancKey, CompoundState(existingRegions))
		} else {
			builtBranch = SingleNested(ancKey, builtBranch)
		}
	}

	if len(lcaParts) == 0 {
		if strings.EqualFold(m.Type, "parallel") && currentState.IsCompound {
			topRegionKey := tgtParts[0]
			regionVal := builtBranch
			if builtBranch.IsCompound {
				if r, ok := builtBranch.Compound[topRegionKey]; ok {
					regionVal = r
				}
			}
			nextRoot := make(map[string]StateValue, len(currentState.Compound))
			for k, v := range currentState.Compound {
				nextRoot[k] = v
			}
			nextRoot[topRegionKey] = regionVal
			return AppliedTransition{
				TargetPath:     targetPath,
				NextStateValue: CompoundState(nextRoot),
				ExitEffects:    exitEffects,
				EntryEffects:   entryEffects,
			}
		}
		return AppliedTransition{
			TargetPath:     targetPath,
			NextStateValue: builtBranch,
			ExitEffects:    exitEffects,
			EntryEffects:   entryEffects,
		}
	}

	nextState := replaceAtLca(m, currentState, lcaParts, 0, builtBranch)
	return AppliedTransition{
		TargetPath:     targetPath,
		NextStateValue: nextState,
		ExitEffects:    exitEffects,
		EntryEffects:   entryEffects,
	}
}

func collectExitEffects(m *MachineDefinition, sv StateValue, subtreePrefix string) []string {
	leaves := GetActiveLeafPaths(m, sv)
	visited := make(map[string]bool)
	var exitEffects []string

	for _, leafPath := range leaves {
		if subtreePrefix != "" && leafPath != subtreePrefix && !strings.HasPrefix(leafPath, subtreePrefix+".") {
			continue
		}
		segments := strings.Split(leafPath, ".")
		for length := len(segments); length >= 1; length-- {
			candidate := strings.Join(segments[:length], ".")
			if subtreePrefix != "" && candidate != subtreePrefix && !strings.HasPrefix(candidate, subtreePrefix+".") {
				break
			}
			if !visited[candidate] {
				visited[candidate] = true
				if n := getNodeByPath(m, candidate); n != nil {
					exitEffects = append(exitEffects, n.Exit...)
				}
			}
		}
	}
	return exitEffects
}

func extractSubStateMap(rootVal StateValue, dotPath string) map[string]StateValue {
	parts := strings.Split(dotPath, ".")
	cursor := rootVal
	for _, part := range parts {
		if part == "" {
			continue
		}
		if !cursor.IsCompound {
			return make(map[string]StateValue)
		}
		child, ok := cursor.Compound[part]
		if !ok {
			return make(map[string]StateValue)
		}
		cursor = child
	}
	if cursor.IsCompound {
		res := make(map[string]StateValue, len(cursor.Compound))
		for k, v := range cursor.Compound {
			res[k] = v
		}
		return res
	}
	return make(map[string]StateValue)
}

func replaceAtLca(m *MachineDefinition, current StateValue, lcaParts []string, depth int, replacementBranch StateValue) StateValue {
	key := lcaParts[depth]
	currentPath := strings.Join(lcaParts[:depth+1], ".")
	node := getNodeByPath(m, currentPath)

	if depth == len(lcaParts)-1 {
		if node != nil && node.IsParallel() && current.IsCompound {
			existingParallel, has := current.Compound[key]
			regions := make(map[string]StateValue)
			if has && existingParallel.IsCompound {
				for rk, rv := range existingParallel.Compound {
					regions[rk] = rv
				}
			}
			if replacementBranch.IsCompound && len(replacementBranch.Compound) > 0 {
				for rk, rv := range replacementBranch.Compound {
					regions[rk] = rv
				}
				updatedOuter := make(map[string]StateValue, len(current.Compound))
				for k, v := range current.Compound {
					updatedOuter[k] = v
				}
				updatedOuter[key] = CompoundState(regions)
				return CompoundState(updatedOuter)
			}
		}

		if current.IsCompound {
			updated := make(map[string]StateValue, len(current.Compound))
			for k, v := range current.Compound {
				updated[k] = v
			}
			updated[key] = replacementBranch
			return CompoundState(updated)
		}
		return SingleNested(key, replacementBranch)
	}

	childCurrent := Leaf("")
	if current.IsCompound {
		if c, ok := current.Compound[key]; ok {
			childCurrent = c
		}
	}
	updatedChild := replaceAtLca(m, childCurrent, lcaParts, depth+1, replacementBranch)

	if current.IsCompound {
		updated := make(map[string]StateValue, len(current.Compound))
		for k, v := range current.Compound {
			updated[k] = v
		}
		updated[key] = updatedChild
		return CompoundState(updated)
	}
	return SingleNested(key, updatedChild)
}

func FindPendingOnDone(m *MachineDefinition, sv StateValue) *MatchedTransition {
	leaves := GetActiveLeafPaths(m, sv)
	candidateContainers := make(map[string]bool)

	for _, leaf := range leaves {
		parts := strings.Split(leaf, ".")
		for i := len(parts) - 1; i >= 1; i-- {
			candidateContainers[strings.Join(parts[:i], ".")] = true
		}
	}

	var sorted []string
	for c := range candidateContainers {
		sorted = append(sorted, c)
	}
	sort.Slice(sorted, func(i, j int) bool {
		return len(strings.Split(sorted[i], ".")) > len(strings.Split(sorted[j], "."))
	})

	for _, containerPath := range sorted {
		container := getNodeByPath(m, containerPath)
		if container == nil || len(container.OnDone) == 0 {
			continue
		}

		if container.IsCompound() {
			var childLeaves []string
			for _, l := range leaves {
				if strings.HasPrefix(l, containerPath+".") {
					childLeaves = append(childLeaves, l)
				}
			}
			if len(childLeaves) == 1 {
				leafNode := getNodeByPath(m, childLeaves[0])
				if leafNode != nil && leafNode.IsFinal() {
					return &MatchedTransition{SourceNode: container, Edge: container.OnDone[0], SourcePath: containerPath}
				}
			}
		} else if container.IsParallel() {
			allRegionsDone := true
			for _, region := range container.States {
				regPath := containerPath + "." + region.Id
				var regLeaves []string
				for _, l := range leaves {
					if l == regPath || strings.HasPrefix(l, regPath+".") {
						regLeaves = append(regLeaves, l)
					}
				}
				if len(regLeaves) == 0 {
					allRegionsDone = false
					break
				}
				for _, rl := range regLeaves {
					if !isBranchFinalAt(m, regPath, rl) {
						allRegionsDone = false
						break
					}
				}
				if !allRegionsDone {
					break
				}
			}
			if allRegionsDone {
				return &MatchedTransition{SourceNode: container, Edge: container.OnDone[0], SourcePath: containerPath}
			}
		}
	}
	return nil
}

func isBranchFinalAt(m *MachineDefinition, regionPath string, leafPath string) bool {
	leaf := getNodeByPath(m, leafPath)
	if leaf == nil || !leaf.IsFinal() {
		return false
	}
	region := getNodeByPath(m, regionPath)
	if region == nil {
		return false
	}
	if region.IsFinal() {
		return true
	}
	if region.IsCompound() {
		return leafPath == regionPath+"."+leaf.Id
	}
	return false
}

func ResolveSettledStatus(m *MachineDefinition, sv StateValue, wasCompensated bool) TransactionStatus {
	if wasCompensated {
		return StatusCompensated
	}
	if !sv.IsCompound && sv.Atomic == "error" {
		if _, ok := m.States["error"]; ok {
			return StatusFailed
		}
	}

	leaves := GetActiveLeafPaths(m, sv)
	if len(leaves) > 0 {
		allFinal := true
		for _, l := range leaves {
			n := getNodeByPath(m, l)
			if n == nil || !n.IsFinal() {
				allFinal = false
				break
			}
		}
		if allFinal {
			return StatusCompleted
		}
	}
	return StatusIdle
}

func GetAvailableEvents(m *MachineDefinition, sv StateValue) []string {
	leaves := GetActiveLeafPaths(m, sv)
	eventsMap := make(map[string]bool)

	for _, leafPath := range leaves {
		parts := strings.Split(leafPath, ".")
		for length := len(parts); length >= 1; length-- {
			candidate := strings.Join(parts[:length], ".")
			node := getNodeByPath(m, candidate)
			if node == nil || node.IsFinal() {
				continue
			}
			for evt := range node.On {
				eventsMap[evt] = true
			}
		}
	}

	var events []string
	for e := range eventsMap {
		events = append(events, e)
	}
	sort.Strings(events)
	return events
}

func GetTerminalStates(m *MachineDefinition) []string {
	var terminals []string
	walkTerminals(m.States, "", &terminals)
	sort.Strings(terminals)
	return terminals
}

func walkTerminals(states map[string]*StateDefinition, prefix string, list *[]string) {
	for k, s := range states {
		currentPath := k
		if prefix != "" {
			currentPath = prefix + "." + k
		}
		if s.IsFinal() || k == "error" {
			*list = append(*list, currentPath)
		}
		if len(s.States) > 0 {
			walkTerminals(s.States, currentPath, list)
		}
	}
}

