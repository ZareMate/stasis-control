-- =========================================================
-- GENERIC LIST MENU
-- =========================================================
-- Items:
--   {
--       name = "Display name",
--       color = colors.white,
--       onConfirm = function() ... end
--   }
--
-- config.items can be a table or a function returning a table.
-- onBack is called when Backspace is pressed.
-- onTerminate is called when C is pressed.
-- A confirm callback returning true closes the menu.
-- =========================================================

local M = {}

local function resolve(value, item)
    if type(value) == "function" then
        return value(item)
    end

    return value
end

function M.open(config)
    local selected = 1
    local scrollOffset = 0

    while true do
        local items = config.items

        if type(items) == "function" then
            items = items()
        end

        if type(items) ~= "table" then
            items = {}
        end

        if #items == 0 then
            selected = 1
        else
            selected = math.max(1, math.min(selected, #items))
        end

        local width, height = term.getSize()
        local footerLines = config.footerLines or 2
        local firstLine = config.firstLine or 3
        local lastLine = math.max(firstLine, height - footerLines)
        local visibleCount = math.max(1, lastLine - firstLine + 1)

        if selected - scrollOffset > visibleCount then
            scrollOffset = selected - visibleCount
        elseif selected - scrollOffset < 1 then
            scrollOffset = selected - 1
        end

        local maxScroll = math.max(0, #items - visibleCount)
        scrollOffset = math.min(scrollOffset, maxScroll)

        term.clear()
        term.setBackgroundColor(colors.black)
        term.setTextColor(colors.white)

        if config.header then
            local returnedLine = config.header(width, height)
            if type(returnedLine) == "number" then
                firstLine = returnedLine
                lastLine = math.max(firstLine, height - footerLines)
                visibleCount = math.max(1, lastLine - firstLine + 1)

                if selected - scrollOffset > visibleCount then
                    scrollOffset = selected - visibleCount
                elseif selected - scrollOffset < 1 then
                    scrollOffset = selected - 1
                end

                maxScroll = math.max(0, #items - visibleCount)
                scrollOffset = math.min(scrollOffset, maxScroll)
            end
        elseif config.title then
            term.setCursorPos(1, 1)
            term.write(config.title:sub(1, width))
        end

        for i = 1, visibleCount do
            local index = i + scrollOffset
            local item = items[index]

            if item then
                local name = resolve(item.name, item) or ""
                local color = resolve(item.color, item) or colors.white
                local y = firstLine + i - 1

                term.setCursorPos(2, y)

                if index == selected then
                    term.setBackgroundColor(colors.gray)
                    term.setTextColor(colors.white)
                    term.clearLine()
                    term.setCursorPos(2, y)
                    term.write("> " .. tostring(name))
                else
                    term.setBackgroundColor(colors.black)
                    term.setTextColor(color)
                    term.clearLine()
                    term.setCursorPos(2, y)
                    term.write("  " .. tostring(name))
                end
            end
        end

        term.setBackgroundColor(colors.black)
        term.setTextColor(colors.white)

        if scrollOffset > 0 then
            term.setCursorPos(width, firstLine)
            term.write("^")
        end

        if scrollOffset < maxScroll then
            term.setCursorPos(width, lastLine)
            term.write("v")
        end

        if config.footer then
            config.footer(width, height)
        else
            term.setCursorPos(1, height)
            term.setTextColor(colors.lightGray)
            term.write("Up/Down: Navigate  Enter: Select")

            if height > 1 then
                term.setCursorPos(1, height - 1)
                term.write("Backspace: Back  C: Terminate")
            end
        end

        local event, key = os.pullEvent()

        if event == "key" then
            if key == keys.c then
                if config.onTerminate then
                    config.onTerminate()
                end
            elseif key == keys.up then
                if #items > 0 then
                    if config.wrap == false then
                        selected = math.max(1, selected - 1)
                    else
                        selected = selected > 1 and selected - 1 or #items
                    end
                end
            elseif key == keys.down then
                if #items > 0 then
                    if config.wrap == false then
                        selected = math.min(#items, selected + 1)
                    else
                        selected = selected < #items and selected + 1 or 1
                    end
                end
            elseif key == keys.enter then
                local item = items[selected]

                if item and item.onConfirm then
                    local close = item.onConfirm(item)
                    if close then
                        return
                    end
                end
            elseif key == keys.backspace then
                if config.onBack then
                    config.onBack()
                end
                return
            end
        end
    end
end

return M
