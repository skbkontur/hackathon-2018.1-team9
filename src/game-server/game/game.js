const {Field} = require('./field.js');
const {Ball, COLORS} = require('./ball.js');

const TICK_DELAY = 250;

const DROP_COLORS = [
    COLORS.BLUE, COLORS.CYAN, COLORS.GREEN, COLORS.MAGENTA, COLORS.RED, COLORS.YELLOW
];

class Game {
    constructor(dropSize, targetScore, fieldSize) {
        this.dropSize = dropSize;
        this.targetScore = targetScore;
        this.fields = [
            new Field(fieldSize, fieldSize),
            new Field(fieldSize, fieldSize)
        ];
        this.points = [
            0,
            0,
        ];

        this.fieldSize = fieldSize;

        this.dropColors = [];
        this.dropPositions = [];
        this.dropPowerUps = [];

        this.tickNumber = 0;

        this.paused = true;
        this.lastTickTime = null;

        this.players = [];

        this.playersBonuses = [
            [], []
        ];

        this.playersTickChanges = [
            [], []
        ];

        this.changesHistory = [];

        this.commonTickActions = {};
    }

    start(player1, player2) {
        this.players.push(player1, player2);
        player1.game = this;
        player2.game = this;

        this.doDropToField(this.fields[0]);
        this.doDropToField(this.fields[0]);
        this.doDropToField(this.fields[1]);
        this.doDropToField(this.fields[1]);

        this.players.forEach((player, playerIndex) => {
            const otherPlayerIndex = playerIndex === 0 ? 1 : 0;

            const gameData = {
                myBonuses: this.playersBonuses[playerIndex],
                myFieldData: {
                    width: this.fields[playerIndex].width,
                    height: this.fields[playerIndex].height,
                    field: this.fields[playerIndex].cells.map((x) => x.map(
                        (cell) => cell.ball && {
                            color: cell.ball.color,
                            type: "ball",
                            snow: cell.ball.snow,
                            haveBonus: Boolean(cell.ball.bonus)
                        }
                    )),
                    points: this.points[0],
                },
                otherFieldData: {
                    width: this.fields[otherPlayerIndex].width,
                    height: this.fields[otherPlayerIndex].height,
                    field: this.fields[otherPlayerIndex].cells.map((x) => x.map(
                        (cell) => cell.ball && {
                            color: cell.ball.color,
                            type: "ball",
                            snow: cell.ball.snow,
                            haveBonus: Boolean(cell.ball.bonus)
                        }
                    )),
                    points: this.points[1],
                }
            };

            player.sockets.forEach((ws) => {
                ws.send(JSON.stringify({action: "full-update", data: gameData}));
            })

        });

        this.paused = false;
        this.tick();
    }

    tick() {
        if (this.paused) {
            this.onEnd && this.onEnd();
            return;
        }
        if (this.lastTickTime === null ) {
            this.lastTickTime = (new Date()).getTime();
            setTimeout(() => this.tick(), TICK_DELAY);

            return;
        }

        this.tickNumber += 1;

        this.processPlayerActions(this.players[0]);
        this.processPlayerActions(this.players[1]);
        this.processCommonAction();

        const changes1 = JSON.stringify([
            ...this.changesHistory.map((pack, idx, arr) => {
                return {
                    tick: this.tickNumber - arr.length + idx,
                    changes: pack[0]
                }
            }),
            {tick: this.tickNumber, changes: this.playersTickChanges[0]}
        ]);

        this.players[0].sockets.forEach(socket => {
            socket.send(changes1);
        });

        const changes2 = JSON.stringify([
            ...this.changesHistory.map((pack, idx, arr) => {
                return {
                    tick: this.tickNumber - arr.length + idx,
                    changes: pack[1]
                }
            }),
            {tick: this.tickNumber, changes: this.playersTickChanges[1]}
        ]);

        this.players[1].sockets.forEach(socket => {
            socket.send(changes2);
        });

        this.changesHistory.push(this.playersTickChanges);
        if (this.changesHistory.length > 3) {
            this.changesHistory.shift();
        }

        this.playersTickChanges = [
            [], []
        ];

        const newDate = (new Date()).getTime();
        let timeToNextTick = TICK_DELAY - (newDate - this.lastTickTime - TICK_DELAY);

        if (timeToNextTick < TICK_DELAY / 2) {
            timeToNextTick = TICK_DELAY / 2;
        }

        setTimeout(() => this.tick(), timeToNextTick);
        this.lastTickTime = newDate;
    }

    processPlayerActions(player) {
        if (!player.calledAction) {
            return;
        }

        const playerIndex = this.players.indexOf(player);
        const field = this.fields[playerIndex];

        switch (player.calledAction.action) {
            case 'try-move':
                if (player.ballInteractive) {
                    const way = field.findWay(player.calledAction.data.from, player.calledAction.data.to);
                    if (way.length) {
                        player.ballInteractive = false;
                        this.playersTickChanges[playerIndex].push({ballInteractive: false});
                        way.forEach((cell, idx, arr) => {
                            if (idx === arr.length - 1) {
                                return;
                            }

                            this.commonTickActions[this.tickNumber + idx] =
                                this.commonTickActions[this.tickNumber + idx] || [];

                            this.commonTickActions[this.tickNumber + idx].push({
                                action: "move-ball",
                                field: field,
                                from: cell.toPlain(),
                                to: arr[idx + 1].toPlain()
                            });
                        });

                        this.commonTickActions[this.tickNumber + way.length - 1] =
                            this.commonTickActions[this.tickNumber + way.length - 1] || [];

                        this.commonTickActions[this.tickNumber + way.length - 1].push({
                            action: "enable-ball-interactive",
                            player: player,
                        });
                        this.commonTickActions[this.tickNumber + way.length - 2].push({
                            action: "stop-ball-animation",
                            field: field,
                            cell: way[way.length - 1].toPlain()
                        });
                        this.commonTickActions[this.tickNumber + way.length - 1].push({
                            action: "check-line",
                            field: field,
                        });
                    } else {
                        this.playersTickChanges[playerIndex].push("badTurnTry");
                    }
                }
                break;

            case 'activate-bonus':
                const bonusType = player.calledAction.bonus;
                if (this.playersBonuses[playerIndex].includes(bonusType)) {
                    this.playersBonuses[playerIndex].splice(this.playersBonuses[playerIndex].indexOf(bonusType), 1);
                    this.processBonus(player, bonusType);
                }
                break;
        }

        player.calledAction = null;
    }

    processBonus(player, bonusType) {
        const currentPlayerIndex = this.players.indexOf(player);
        const otherPlayerIndex = currentPlayerIndex === 1 ? 0 : 1;

        switch (bonusType) {
            case "BLACK_BALL":
                this.commonTickActions[this.tickNumber + 1] = this.commonTickActions[this.tickNumber + 1] || [];
                this.commonTickActions[this.tickNumber + 1].push({
                    action: 'black-drop',
                    source: currentPlayerIndex,
                    target: otherPlayerIndex
                });

                break;
            case "FROZEN":
                this.commonTickActions[this.tickNumber + 1] = this.commonTickActions[this.tickNumber + 1] || [];
                this.commonTickActions[this.tickNumber + 1].push({
                    action:'frozen',
                    source: currentPlayerIndex,
                    target: otherPlayerIndex
                });

                break;
        }
    }

    processCommonAction() {
        if (this.commonTickActions[this.tickNumber]) {
            this.commonTickActions[this.tickNumber].forEach((data) => {
                switch (data.action) {
                    case 'black-drop':
                        const blackBall = new Ball(COLORS.BLACK);

                        const blackBoxPos = this.fields[data.target].placeDrop(
                            blackBall,
                            Math.floor(Math.random() * this.fieldSize * this.fieldSize)
                        );

                        this.players.forEach((player, playerIndex) => {
                            this.playersTickChanges[playerIndex].push({
                                action: "spawn-balls",
                                onMyField: data.target === playerIndex,
                                drops: [{
                                    position: blackBoxPos,
                                    color: blackBall.color,
                                    haveBonus: Boolean(blackBall.bonus)
                                }]
                            });
                        });

                        this.playersTickChanges[data.source].push({
                            action: "remove-bonus",
                            bonus: "BLACK_BALL"
                        });
                        break;
                    case 'frozen':
                        const frozenPositions = [];

                        for(let i = 0; i < 3; i++) {
                            const number = Math.floor(
                                Math.random() * (this.fieldSize * this.fieldSize - this.fields[data.target].freeCells)
                            );
                            let x = 0;
                            let y = 0;

                            for (let j = 0; j < number && x < this.fieldSize && y < this.fieldSize;) {
                                y++;
                                if (y >= this.fieldSize) {
                                    y = 0;
                                    x++;
                                }

                                if (x < this.fieldSize && y < this.fieldSize
                                    && this.fields[data.target].cells[x][y].ball
                                ) {
                                    j++;
                                }
                            }

                            if (x < this.fieldSize && y < this.fieldSize && this.fields[data.target].cells[x][y].ball) {
                                this.fields[data.target].cells[x][y].ball.snow = true;
                                frozenPositions.push({x, y});
                            }
                        }

                        this.players.forEach((player, playerIndex) => {
                            this.playersTickChanges[playerIndex].push({
                                action: "snow",
                                onMyField: data.target === playerIndex,
                                balls: frozenPositions
                            });
                        });

                        this.playersTickChanges[data.source].push({
                            action: "remove-bonus",
                            bonus: "FROZEN"
                        });
                        break;
                    case "move-ball":
                        const {x, y} = data.from;
                        const {x: x1, y: y1} = data.to;
                        const ball = data.field.cells[x][y].ball;
                        if (ball && !data.field.cells[x1][y1].ball) {
                            data.field.cells[x][y].ball = null;
                            data.field.cells[x1][y1].ball = ball;

                            this.players.forEach((player, playerIndex) => {
                                this.playersTickChanges[playerIndex].push({
                                    action: "move-ball",
                                    onMyField: data.field === this.fields[playerIndex],
                                    from: data.from,
                                    to: data.to
                                });
                            });

                        }
                        break;
                    case "stop-ball-animation":
                        this.players.forEach((player, playerIndex) => {
                            this.playersTickChanges[playerIndex].push({
                                action: "stop-ball-animation",
                                onMyField: data.field === this.fields[playerIndex],
                                cell: data.cell
                            });
                        });
                        break;
                    case "enable-ball-interactive": {
                        data.player.ballInteractive = true;
                        const playerIndex = this.players.indexOf(data.player);

                        this.playersTickChanges[playerIndex].push("enable-ball-interactive");
                    }
                        break;
                    case "check-line":
                        const field = data.field;
                        let {points, cells} = field.getLines();
                        let cellsPlain = [];
                        let unfreeze = [];
                        if (cells.length > 0) {
                            this.points[this.fields.indexOf(field)] += points;
                            for (let i = 0; i < cells.length; i++) {
                                if (cells[i].ball && cells[i].ball.snow) {
                                    cells[i].ball.snow = false;
                                    unfreeze.push(cells[i].toPlain());
                                } else {
                                    if (cells[i].ball.bonus) {
                                        this.playersBonuses[this.fields.indexOf(field)].push(cells[i].ball.bonus);
                                        this.playersTickChanges[this.fields.indexOf(field)].push({
                                            action: "get-bonus",
                                            bonus: cells[i].ball.bonus,
                                            cells: cells[i].toPlain()
                                        });
                                    }
                                    cells[i].ball = null;
                                    field.freeCells += 1;
                                    cellsPlain.push(cells[i].toPlain());
                                }
                            }


                            this.players.forEach((player, playerIndex) => {
                                this.playersTickChanges[playerIndex].push({
                                    action: "delete-ball",
                                    onMyField: data.field === this.fields[playerIndex],
                                    cells: cellsPlain,
                                });
                                this.playersTickChanges[playerIndex].push({
                                    action: "unfreeze-ball",
                                    onMyField: data.field === this.fields[playerIndex],
                                    cells: unfreeze,
                                });
                                this.playersTickChanges[playerIndex].push({
                                    action: "add-points",
                                    onMyField: data.field === this.fields[playerIndex],
                                    pointAdd: points,
                                    pointMy: this.points[playerIndex],
                                    pointOther: this.points[(playerIndex+1)%2]
                                });
                            });
                        } else {
                            const drops = this.doDropToField(field);

                            if (drops.length === 0) {
                                this.paused = true;

                                this.players.forEach((player, playerIndex) => {
                                    this.playersTickChanges[playerIndex].push({
                                        action: "end-games",
                                        result: {
                                            win: this.points[playerIndex] > this.points[(playerIndex + 1) % 2],
                                            myPoints: this.points[playerIndex],
                                            otherPoints: this.points[(playerIndex + 1) % 2],
                                        }
                                    });
                                });

                            } else {
                                this.players.forEach((player, playerIndex) => {
                                    this.playersTickChanges[playerIndex].push({
                                        action: "spawn-balls",
                                        onMyField: data.field === this.fields[playerIndex],
                                        drops: drops.map(drop => {
                                            return {
                                                position: drop.position,
                                                color: drop.ball.color,
                                                haveBonus: Boolean(drop.ball.bonus)
                                            }
                                        })
                                    });
                                });
                            }
                        }

                        break;
                }
            });

            delete(this.commonTickActions[this.tickNumber]);
        }
    }

    getDropColors(dropNumber) {
        while (this.dropColors.length < dropNumber + 1) {
            const drop = [];

            for (let i = 0; i < this.dropSize; i++) {
                if (Math.random() <= 0.07) {
                    drop.push(COLORS.RAINBOW);
                } else {
                    drop.push(DROP_COLORS[Math.floor(Math.random() * DROP_COLORS.length)]);
                }
            }

            this.dropColors.push(drop);
        }

        return this.dropColors[dropNumber];
    }

    getDropPowerUps(dropNumber) {
        while (this.dropPowerUps.length < dropNumber + 1) {
            const drop = [];

            for (let i = 0; i < this.dropSize; i++) {
                if (Math.random() <= 0.35) {
                    if (Math.random() >= 0.5) {
                       drop.push("FROZEN");
                    } else {
                        drop.push("BLACK_BALL");
                    }
                } else {
                    drop.push(null);
                }
            }

            this.dropPowerUps.push(drop);
        }

        return this.dropPowerUps[dropNumber];
    }

    getDropPositions(dropNumber) {
        while (this.dropPositions.length < dropNumber + 1) {
            const drop = [];

            for (let i = 0; i < this.dropSize; i++) {
                drop.push(Math.floor(Math.random() * this.fieldSize * this.fieldSize));
            }

            this.dropPositions.push(drop);
        }

        return this.dropPositions[dropNumber];
    }

    /**
     *
     * @param {Field} field
     * @returns {Array}
     */
    doDropToField(field) {
        if (field.freeCells <= this.dropSize) {
            return [];
        }
        const dropColors = this.getDropColors(field.nextDrop);
        const dropPositions = this.getDropPositions(field.nextDrop);
        const dropPowerUps = this.getDropPowerUps(field.nextDrop);

        const dropResult = [];

        for (let p = 0; p < dropPositions.length; p++) {
            const ball = new Ball(dropColors[p]);
            ball.bonus = dropPowerUps[p];

            const {x, y} = field.placeDrop(ball, dropPositions[p]);

            dropResult.push({position: {x, y}, ball});
        }

        field.nextDrop += 1;

        return dropResult;
    }
}

module.exports = {
    Game
};
